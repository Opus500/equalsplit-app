// Single-gate timing, in two engines that are DELIBERATELY NOT unified.
//
// One gate. The second stays free, and because both ends of a continuous interval
// are edges on the SAME gate, the result is intra-clock and exact with no
// cross-gate sync — the Shuttle Run property.
//
//   RepeatEngine   CONTINUOUS. A 1200m as three laps. The first BREAK is t0;
//                  every qualifying BREAK after it closes a lap and opens the
//                  next. CHAINED: the intervals PARTITION elapsed time, which is
//                  why a spurious crossing is repaired by removing a BOUNDARY
//                  (mergeCrossing), never by deleting time that really elapsed.
//                  Ends on a BUTTON and emits N times: one rep-set row, mode 4.
//
//   RestRepEngine  REPEATS WITH REST. The coach taps, the athlete goes from
//                  standing, the crossing ends that rep — and that rep IS the
//                  run. Emits ONE time and returns to idle; the next rep is a
//                  fresh tap and a fresh row. Nothing chained, nothing
//                  accumulated, no set container, no mean, no review list, no lap
//                  count — those all existed to make sense of a chain. A single
//                  time from an app-parameterized drill is DRILL_MODE, a shape
//                  that already exists; a mode carrying only a label would be noise.
//
// The START is the difference that matters. Continuous starts on a gate edge and
// is exact. A rest rep starts on a HAND TAP and carries ~200ms of reaction
// (HAND_START_ERROR_MS), which must travel with the ROW rather than only being
// said in the UI — hence restRepRawJson() recording startSource:'tap', exact:false.
//
// ONE PHONE CLOCK, AND IT IS THE MONOTONIC ONE. Every `monoMs` here — the tap, the
// frame arrival — must come from the SAME source the BLE layer stamps frames with
// (perfNow / performance.now, GateProvider). Mixing in a Date.now() reading is not
// a small error: the two bases differ by ~1.8e12, so a rest rep computed across
// them fails its lockout and is silently swallowed. That bug shipped. The `diag`
// counters exist so it can never be silent again — a hugely negative lastRejectMs
// IS a clock mismatch, and says so on the Debug screen.

import { sdiff32 } from './clockSync';
import { clampToBounds, passedLockoutMs, passedLockoutUs, type LockoutBounds } from './lockout';
import type { V2Frame } from './v2';

/**
 * History `mode` for a CONTINUOUS rep set.
 *
 * It earned a mode because it is the only row carrying MANY times instead of one:
 * History renders it expandable and the chart reads it differently. A rest rep
 * does not qualify — it is a single time, so it reuses DRILL_MODE.
 */
export const REPEAT_MODE = 4;

/** Rough reaction cost of a hand-tapped start. Recorded ON THE ROW and shown in
 *  the UI, so a tap-started rep is never read as gate-accurate. */
export const HAND_START_ERROR_MS = 200;

export type RepeatVariant = 'continuous' | 'rest';

export type RepeatConfig = {
  /** stable id — persistence key for the tuned lockout; never shown. */
  key: string;
  variant: RepeatVariant;
  /** mode title for the UI. NOT the drill label: the drill (e.g. "1200m", "400m")
   *  comes from the drill picker, which mints the record the graphs group on. */
  title: string;
  /** the single gate being crossed. */
  gateId: number;
  /** minimum gap before a BREAK counts, measured from the interval's own start. */
  lockoutMs: number;
};

export const REPEAT_CONTINUOUS: RepeatConfig = {
  key: 'repeat-continuous',
  variant: 'continuous',
  title: 'Continuous',
  gateId: 1,
  lockoutMs: 1000,
};

export const REPEAT_REST: RepeatConfig = {
  key: 'repeat-rest',
  variant: 'rest',
  title: 'Repeats with rest',
  gateId: 1,
  lockoutMs: 1000,
};

export const REPEATS: RepeatConfig[] = [REPEAT_CONTINUOUS, REPEAT_REST];

/** Wide upper bound on purpose: raising the lockout is the blunt defence against
 *  an athlete drifting back through the beam. */
export const REPEAT_LOCKOUT_BOUNDS: Record<string, LockoutBounds> = {
  'repeat-continuous': { minMs: 500, maxMs: 60000, stepMs: 500 },
  'repeat-rest': { minMs: 500, maxMs: 60000, stepMs: 500 },
};

export function clampRepeatLockout(key: string, ms: number): number {
  return clampToBounds(REPEAT_LOCKOUT_BOUNDS[key], ms);
}

// ---------------------------------------------------------------------------
// Frame accounting — shared by both engines.
// ---------------------------------------------------------------------------

/** Every counter is a REASON a frame did not become a time, so whichever one
 *  climbs names the fault. Read on the Debug screen. */
export type RepeatDiag = {
  /** beam frames seen at all — 0 means nothing is arriving */
  beam: number;
  /** dropped: a CLEAR edge, not a break */
  clears: number;
  /** dropped: the other gate */
  otherGate: number;
  /** dropped: engine not in a state that accepts a crossing (not armed / no tap) */
  notRunning: number;
  /** dropped: inside the lockout window */
  lockedOut: number;
  /** intervals/reps opened (t0 or a tap) */
  opened: number;
  /** intervals/reps closed */
  accepted: number;
  /** dt (ms) of the last lockout rejection. Hugely negative = CLOCK MISMATCH,
   *  not a lockout that is merely too long. */
  lastRejectMs: number | null;
};

export function emptyDiag(): RepeatDiag {
  return {
    beam: 0,
    clears: 0,
    otherGate: 0,
    notRunning: 0,
    lockedOut: 0,
    opened: 0,
    accepted: 0,
    lastRejectMs: null,
  };
}

// ---------------------------------------------------------------------------
// CONTINUOUS — chained laps, one rep-set row (mode 4).
// ---------------------------------------------------------------------------

// idle    — no set running.
// armed   — waiting for the first crossing, which is t0.
// running — a lap is open.
export type RepeatState = 'idle' | 'armed' | 'running';

export type RepInterval = {
  ms: number;
  /** gate micros at the closing crossing */
  closeUs: number;
  /** MONOTONIC phone ms at the closing crossing (perfNow, never Date.now) */
  closeAtMs: number;
};

export type RepSet = {
  gateId: number;
  /**
   * How many laps were planned, or null if the coach didn't say.
   *
   * A TARGET, never a terminal condition. Auto-ending at the count would be a
   * data-loss bug: one junk crossing ends the set after two real laps, and
   * everything run afterwards is never captured. The review list can remove a
   * spurious boundary; it cannot invent a lap that was never recorded.
   */
  targetLaps: number | null;
  intervals: RepInterval[];
  /** the real total: t0 to the last crossing. This is what gets charted. */
  totalMs: number;
  meanMs: number;
  lockoutMs: number;
  startedAtMs: number;
  endedAtMs: number;
};

export function summarize(intervals: RepInterval[]): { totalMs: number; meanMs: number } {
  const totalMs = intervals.reduce((n, i) => n + i.ms, 0);
  return { totalMs, meanMs: intervals.length ? Math.round(totalMs / intervals.length) : 0 };
}

/** Below this fraction of the median, an interval is probably a walk-back rather
 *  than a lap. Only ever a HINT — never removed automatically. */
export const SUSPECT_RATIO = 0.5;

export type TargetStatus = {
  target: number | null;
  actual: number;
  /** intervals beyond the target — the junk to reconcile. */
  excess: number;
  /** fewer than planned. Informational; never blocks saving, because a short set
   *  really happened and refusing it would lose the laps that did. */
  short: number;
};

export function targetStatus(set: RepSet): TargetStatus {
  const actual = set.intervals.length;
  const target = set.targetLaps ?? null;
  if (target == null || target <= 0) return { target: null, actual, excess: 0, short: 0 };
  return {
    target,
    actual,
    excess: Math.max(0, actual - target),
    short: Math.max(0, target - actual),
  };
}

function median(ns: number[]): number {
  if (!ns.length) return 0;
  const a = [...ns].sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid]! : Math.round((a[mid - 1]! + a[mid]!) / 2);
}

/**
 * Indices that look like junk crossings rather than laps — conspicuously shorter
 * than the rest. A HINT only: a genuinely fast last lap trips the same test, and
 * removing it automatically would delete the best lap of the session.
 */
export function suspectIntervals(set: RepSet): number[] {
  const ms = set.intervals.map((i) => i.ms);
  if (ms.length < 3) return [];
  const cut = median(ms) * SUSPECT_RATIO;
  const out: number[] = [];
  ms.forEach((v, i) => {
    if (v < cut) out.push(i);
  });
  return out;
}

/**
 * Remove the CROSSING separating intervals `boundary` and `boundary + 1`, merging
 * them. The correct repair for a spurious crossing, because continuous intervals
 * partition elapsed time: crossings at 0/62/66/130 give [62, 4, 64], and deleting
 * the 4 would claim a 126s 1200m nobody ran. Removing the boundary gives [62, 68]
 * with the total still 130s.
 *
 * INVARIANT: merging never changes totalMs. Only the boundaries move.
 */
export function mergeCrossing(set: RepSet, boundary: number): RepSet {
  if (boundary < 0 || boundary >= set.intervals.length - 1) return set;
  const a = set.intervals[boundary]!;
  const b = set.intervals[boundary + 1]!;
  const merged: RepInterval = {
    ms: a.ms + b.ms,
    // the surviving boundary is b's close; a's was the spurious one
    closeUs: b.closeUs,
    closeAtMs: b.closeAtMs,
  };
  const intervals = [...set.intervals];
  intervals.splice(boundary, 2, merged);
  return { ...set, intervals, ...summarize(intervals) };
}

/**
 * Delete an interval. Valid ONLY on the last one, where it truncates the set: the
 * final crossing was spurious, so the run really ended at the previous one and the
 * total legitimately drops. An interior delete would subtract elapsed time the
 * athlete spent running, so it is REFUSED — enforced here, not remembered at the
 * call site.
 */
export function dropInterval(set: RepSet, index: number): RepSet {
  if (index < 0 || index >= set.intervals.length) return set;
  if (index < set.intervals.length - 1) return set;
  const intervals = set.intervals.filter((_, i) => i !== index);
  return { ...set, intervals, ...summarize(intervals) };
}

/** A continuous set charts its TOTAL: a 1200m has a real total time, the laps are
 *  its breakdown, and there is exactly one start — a gate edge — so no error
 *  accumulates. Comparability comes from the drill label carrying the distance. */
export function chartValueMs(set: RepSet): number {
  return set.totalMs;
}

export type SavedRepSet = {
  /** 'rest' appears only on LEGACY rows, written before rest reps became ordinary
   *  single-time runs. Still read so old data keeps charting. */
  variant: RepeatVariant;
  intervals: number[];
  targetLaps: number | null;
};

/** Read a saved rep set out of raw_json. Returns null for any other kind of run,
 *  and for anything malformed — a chart must never throw on one bad row. */
export function parseRepSetJson(raw: string | null | undefined): SavedRepSet | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (v?.engine !== 'repeat') return null;
    const variant: RepeatVariant = v.variant === 'rest' ? 'rest' : 'continuous';
    const targetLaps =
      typeof v.targetLaps === 'number' && Number.isFinite(v.targetLaps) && v.targetLaps > 0
        ? v.targetLaps
        : null;
    const intervals = Array.isArray(v.intervals)
      ? v.intervals.filter((n: unknown): n is number => typeof n === 'number' && Number.isFinite(n))
      : [];
    return { variant, intervals, targetLaps };
  } catch {
    return null;
  }
}

/** Chart value for a SAVED rep set: the total. A LEGACY 'rest' set still charts
 *  its mean, because that was the rule when it was written — re-interpreting
 *  stored data would silently move points on an existing graph. */
export function savedChartValueMs(
  raw: string | null | undefined,
  totalMs: number,
): number | null {
  const s = parseRepSetJson(raw);
  if (!s) return null;
  if (s.variant === 'continuous') return totalMs;
  return s.intervals.length ? Math.round(totalMs / s.intervals.length) : totalMs;
}

/**
 * Pure — no React, no BLE. The provider feeds it every parsed frame via ingest()
 * and the screen drives arm()/end().
 */
export class RepeatEngine {
  state: RepeatState = 'idle';
  config: RepeatConfig;
  intervals: RepInterval[] = [];
  /** planned lap count for the live set, or null. Never ends anything. */
  targetLaps: number | null = null;
  diag: RepeatDiag = emptyDiag();

  private openUs = 0;
  private startedAtMs = 0;

  onInterval: ((interval: RepInterval, count: number) => void) | null = null;
  onOpen: ((monoMs: number) => void) | null = null;

  constructor(config: RepeatConfig) {
    this.config = config;
  }

  /** Retune the lockout. Refused mid-set: the laps already collected were
   *  qualified under the old value. */
  setConfig(config: RepeatConfig): void {
    if (this.state !== 'idle') return;
    this.config = config;
  }

  /** @param monoMs monotonic clock, the same one frames carry (perfNow). */
  arm(monoMs: number, targetLaps: number | null = null): void {
    this.intervals = [];
    this.diag = emptyDiag();
    this.targetLaps = targetLaps && targetLaps > 0 ? Math.round(targetLaps) : null;
    this.startedAtMs = monoMs;
    this.openUs = 0;
    this.state = 'armed';
  }

  reset(): void {
    this.state = 'idle';
    this.intervals = [];
  }

  /** Close the set. The lap still OPEN is discarded — the stretch after the last
   *  crossing has no closing crossing, so it is not a time. */
  end(monoMs: number): RepSet {
    const intervals = this.intervals;
    this.state = 'idle';
    this.intervals = [];
    return {
      gateId: this.config.gateId,
      targetLaps: this.targetLaps,
      intervals,
      ...summarize(intervals),
      lockoutMs: this.config.lockoutMs,
      startedAtMs: this.startedAtMs,
      endedAtMs: monoMs,
    };
  }

  ingest(frame: V2Frame, monoMs: number): RepInterval | null {
    if (frame.kind !== 'beam') return null;
    this.diag.beam += 1;
    if (frame.edge !== 'break') {
      this.diag.clears += 1;
      return null;
    }
    if (frame.gateId !== this.config.gateId) {
      this.diag.otherGate += 1;
      return null;
    }

    // The first crossing is t0 and closes nothing.
    if (this.state === 'armed') {
      this.openUs = frame.micros;
      this.state = 'running';
      this.diag.opened += 1;
      this.onOpen?.(monoMs);
      return null;
    }
    if (this.state !== 'running') {
      this.diag.notRunning += 1;
      return null;
    }

    // Gate clock at both ends: exact, wrap-safe.
    if (!passedLockoutUs(frame.micros, this.openUs, this.config.lockoutMs)) {
      this.diag.lockedOut += 1;
      this.diag.lastRejectMs = Math.round(sdiff32(frame.micros, this.openUs) / 1000);
      return null;
    }
    const interval: RepInterval = {
      ms: Math.round(sdiff32(frame.micros, this.openUs) / 1000),
      closeUs: frame.micros,
      closeAtMs: monoMs,
    };
    // The close of this lap opens the next — no gap between intervals.
    this.openUs = frame.micros;
    this.intervals.push(interval);
    this.diag.accepted += 1;
    this.diag.opened += 1;
    this.onInterval?.(interval, this.intervals.length);
    return interval;
  }
}

// ---------------------------------------------------------------------------
// REPEATS WITH REST — one tap, one crossing, one ordinary run.
// ---------------------------------------------------------------------------

// idle  — nothing armed. Rest lives here, and is never timed.
// armed — the coach tapped; the next qualifying crossing ends the rep.
export type RestRepState = 'idle' | 'armed';

export type RestRep = {
  ms: number;
  /** gate micros at the closing crossing */
  closeUs: number;
  /** MONOTONIC phone ms at the closing crossing */
  closeAtMs: number;
  lockoutMs: number;
  gateId: number;
};

/**
 * A rest rep is a complete run on its own: tap, crossing, saved. Returning to
 * idle after each one is what makes the queue advance normally and the discard
 * window apply PER REP — a bad rep is discardable by itself, which beats
 * reviewing a list at the end.
 *
 * Rest is simply the span between a crossing and the next tap, and it is never
 * measured. A crossing during it lands on `notRunning`, which is correct.
 */
export class RestRepEngine {
  state: RestRepState = 'idle';
  config: RepeatConfig;
  diag: RepeatDiag = emptyDiag();

  /** MONOTONIC ms of the tap that opened the current rep. */
  private openAtMs = 0;

  onRep: ((rep: RestRep) => void) | null = null;
  onOpen: ((monoMs: number) => void) | null = null;

  constructor(config: RepeatConfig) {
    this.config = config;
  }

  setConfig(config: RepeatConfig): void {
    if (this.state !== 'idle') return;
    this.config = config;
  }

  /** Clear the tally for a fresh session. Does NOT arm — a rep starts on a tap. */
  resetDiag(): void {
    this.diag = emptyDiag();
  }

  /**
   * The coach taps, the athlete goes from standing.
   * @param monoMs MUST be the same monotonic clock frames carry (perfNow). A
   *   Date.now() reading differs by ~1.8e12 and every crossing is then swallowed.
   */
  arm(monoMs: number): void {
    this.openAtMs = monoMs;
    this.state = 'armed';
    this.diag.opened += 1;
    this.onOpen?.(monoMs);
  }

  /** Abandon the rep in progress. Nothing is emitted, so nothing is saved. */
  reset(): void {
    this.state = 'idle';
  }

  ingest(frame: V2Frame, monoMs: number): RestRep | null {
    if (frame.kind !== 'beam') return null;
    this.diag.beam += 1;
    if (frame.edge !== 'break') {
      this.diag.clears += 1;
      return null;
    }
    if (frame.gateId !== this.config.gateId) {
      this.diag.otherGate += 1;
      return null;
    }
    if (this.state !== 'armed') {
      this.diag.notRunning += 1;
      return null;
    }
    if (!passedLockoutMs(monoMs, this.openAtMs, this.config.lockoutMs)) {
      this.diag.lockedOut += 1;
      // A dt near -1.8e12 is a clock mismatch, not a long lockout. Surfaced
      // rather than swallowed — swallowing it is what made this invisible once.
      this.diag.lastRejectMs = monoMs - this.openAtMs;
      return null;
    }
    const rep: RestRep = {
      ms: monoMs - this.openAtMs,
      closeUs: frame.micros,
      closeAtMs: monoMs,
      lockoutMs: this.config.lockoutMs,
      gateId: this.config.gateId,
    };
    this.state = 'idle'; // rest begins, and is never timed
    this.diag.accepted += 1;
    this.onRep?.(rep);
    return rep;
  }
}

/** What a rest rep writes into raw_json. The accuracy fact travels with the ROW,
 *  not just the UI: a hand-started time must never be read as gate-accurate. */
export function restRepRawJson(rep: RestRep): string {
  return JSON.stringify({
    engine: 'rest-rep',
    startSource: 'tap',
    exact: false,
    handStartErrorMs: HAND_START_ERROR_MS,
    lockoutMs: rep.lockoutMs,
    gateId: rep.gateId,
    closeUs: rep.closeUs,
  });
}

/**
 * How a run's START was timed, read back from storage. ONE helper so History and
 * the chart cannot disagree about which times are gate-accurate.
 *
 * Returns null when the row says nothing — which is every pre-existing run. Those
 * are gate-started by construction, but claiming so from an absent field would be
 * inventing information.
 */
export function runStartSource(raw: string | null | undefined): 'gate' | 'tap' | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (v?.startSource === 'tap') return 'tap';
    if (v?.startSource === 'gate') return 'gate';
    if (v?.engine === 'rest-rep') return 'tap';
    return null;
  } catch {
    return null;
  }
}
