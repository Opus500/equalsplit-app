// Single-gate interval timing. Beside DrillEngine, not inside it — the two differ
// in the things that define a state machine's contract: DrillEngine stops when a
// FRAME says so (counted >= countN) and emits ONE time; this stops when a BUTTON
// says so and emits N. Firmware untouched; the app owns all meaning, as ever.
//
// One gate. The second stays free for another station, and because both ends of a
// continuous interval are edges on the SAME gate, the result is intra-clock and
// exact with no cross-gate sync — the Shuttle Run property.
//
// TWO VARIANTS, and they are not interchangeable:
//
//   CONTINUOUS  — a 1200m run as three laps. The first BREAK is t0; every
//                 qualifying BREAK after it closes a lap and opens the next.
//                 Both ends are gate micros: EXACT.
//
//   REST        — 3x400 with recovery. The coach taps to start each rep, the
//                 athlete starts standing, the crossing ends it. Rest sits
//                 outside every interval, so it is never timed.
//                 The start is a hand tap: it carries reaction error (~200ms,
//                 HAND_START_ERROR_MS) and MUST NOT be presented as gate-accurate.
//
// Nothing is committed until end(). That is what makes the end-of-set interval
// list editable — dropping a spurious crossing is a pure list operation on data
// that has not been written yet.

import { sdiff32 } from './clockSync';
import { clampToBounds, passedLockoutMs, passedLockoutUs, type LockoutBounds } from './lockout';
import type { V2Frame } from './v2';

/**
 * History `mode` for a rep set.
 *
 * A new mode, unlike a new drill: `mode` discriminates ROW SHAPE, and this is the
 * first row carrying many times instead of one. History has to render it
 * expandable and the chart has to read it differently, and deciding that by
 * parsing raw_json would mean parsing JSON to pick a layout. A new *drill* still
 * needs only a new label.
 */
export const REPEAT_MODE = 4;

/** Rough reaction cost of a hand-tapped start. Shown in the UI for the REST
 *  variant so a tap-started rep is never read as a gate-accurate time. */
export const HAND_START_ERROR_MS = 200;

export type RepeatVariant = 'continuous' | 'rest';

export type RepeatConfig = {
  /** stable id — persistence key for the tuned lockout; never shown. */
  key: string;
  variant: RepeatVariant;
  /** mode title for the UI. NOT the drill label: the drill (e.g. "1200m",
   *  "400m x3") comes from the drill picker, which is what mints the record the
   *  progression series groups on. */
  title: string;
  /** the single gate being crossed. */
  gateId: number;
  /** minimum gap before a BREAK counts as a new crossing, measured from the
   *  interval's own start (t0, the previous close, or the tap). */
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
 *  an athlete drifting back through the beam between reps, for anyone who would
 *  rather not prune the list afterwards. */
export const REPEAT_LOCKOUT_BOUNDS: Record<string, LockoutBounds> = {
  'repeat-continuous': { minMs: 500, maxMs: 60000, stepMs: 500 },
  'repeat-rest': { minMs: 500, maxMs: 60000, stepMs: 500 },
};

export function clampRepeatLockout(key: string, ms: number): number {
  return clampToBounds(REPEAT_LOCKOUT_BOUNDS[key], ms);
}

// idle    — no set running.
// armed   — CONTINUOUS only: waiting for the first crossing, which is t0.
// running — an interval is open.
// resting — REST only: set is live, no interval open, waiting for the next tap.
export type RepeatState = 'idle' | 'armed' | 'running' | 'resting';

export type RepInterval = {
  ms: number;
  /** gate micros at the closing crossing */
  closeUs: number;
  /** phone ms at the closing crossing */
  closeAtMs: number;
  /** how this interval's START was timed — the accuracy story, per interval */
  startSource: 'gate' | 'tap';
};

export type RepSet = {
  variant: RepeatVariant;
  gateId: number;
  /**
   * How many laps/reps were planned, or null if the coach didn't say.
   *
   * A TARGET, never a terminal condition. Auto-ending at the count would be a
   * data-loss bug: one junk crossing ends the set after two real laps, and
   * everything run afterwards is never captured at all. The review list can drop
   * a spurious interval; it cannot invent one that was never recorded. So the
   * count only drives live progress and the excess flag — the coach still ends
   * the set.
   */
  targetLaps: number | null;
  intervals: RepInterval[];
  /** sum of the intervals. For CONTINUOUS this is the real total (a 1200m time);
   *  for REST it is a sum of efforts with the rest excluded, which is not a time
   *  anybody ran — see chartValueMs. */
  totalMs: number;
  meanMs: number;
  lockoutMs: number;
  /** every interval is gate-timed at both ends */
  exact: boolean;
  startedAtMs: number;
  endedAtMs: number;
};

export function summarize(intervals: RepInterval[]): { totalMs: number; meanMs: number } {
  const totalMs = intervals.reduce((n, i) => n + i.ms, 0);
  return { totalMs, meanMs: intervals.length ? Math.round(totalMs / intervals.length) : 0 };
}

/** Below this fraction of the median, an interval is probably a walk-back rather
 *  than a lap. Only ever a HINT for the review list — never dropped automatically. */
export const SUSPECT_RATIO = 0.5;

export type TargetStatus = {
  target: number | null;
  actual: number;
  /** intervals beyond the target — the junk to drop. 0 when none, or no target. */
  excess: number;
  /** fewer than planned. Informational only; it never blocks saving, because a
   *  short set is a real thing that happened (athlete pulled up) and refusing to
   *  store it would lose the reps that DID happen. */
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
 * than the rest of the set. A walk-back through the beam produces a few seconds
 * between two real laps; a real lap does not.
 *
 * A HINT for the review list only. Which interval to drop stays the coach's call:
 * a genuinely fast last lap would trip the same test, and auto-dropping it would
 * delete the best rep of the session.
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
 * Remove the CROSSING that separates intervals `boundary` and `boundary + 1`,
 * merging them into one. CONTINUOUS only.
 *
 * This is the correct repair for a spurious crossing in a chained set, and
 * deleting the short interval is NOT. Continuous intervals partition the elapsed
 * time from t0 to the last crossing: the athlete was running through all of it.
 * Crossings at 0/62/66/130 give [62.0, 4.0, 64.0]; the 66 is a walk-back, and
 * deleting its 4.0s interval would claim a 126s 1200m that nobody ran. Removing
 * the BOUNDARY gives [62.0, 68.0] — total still 130s, which is the truth. A
 * spurious crossing is a boundary that shouldn't be there, not time that didn't
 * happen.
 *
 * INVARIANT: merging never changes totalMs. Only the boundaries move.
 */
export function mergeCrossing(set: RepSet, boundary: number): RepSet {
  // Rest intervals are not chained — each is its own tap-to-crossing effort with
  // untimed rest between, so there is no boundary to remove. See dropInterval.
  if (set.variant !== 'continuous') return set;
  if (boundary < 0 || boundary >= set.intervals.length - 1) return set;
  const a = set.intervals[boundary]!;
  const b = set.intervals[boundary + 1]!;
  const merged: RepInterval = {
    ms: a.ms + b.ms,
    // the surviving boundary is b's close; a's was the spurious one
    closeUs: b.closeUs,
    closeAtMs: b.closeAtMs,
    startSource: a.startSource,
  };
  const intervals = [...set.intervals];
  intervals.splice(boundary, 2, merged);
  return { ...set, intervals, ...summarize(intervals) };
}

/**
 * Delete an interval outright. Correct for REST — each rep is tap-start to
 * crossing with untimed rest between, so the intervals are independent and a junk
 * crossing closed one early; there is nothing to merge into.
 *
 * For CONTINUOUS this is only valid on the LAST interval, where it truncates the
 * set: the final crossing was spurious, so the run really did end at the previous
 * one and the total legitimately drops. An interior delete would subtract elapsed
 * time the athlete spent running, so it is REFUSED rather than left available —
 * the invariant is enforced here, not remembered at the call site.
 */
export function dropInterval(set: RepSet, index: number): RepSet {
  if (index < 0 || index >= set.intervals.length) return set;
  if (set.variant === 'continuous' && index < set.intervals.length - 1) return set;
  const intervals = set.intervals.filter((_, i) => i !== index);
  return { ...set, intervals, ...summarize(intervals) };
}

/**
 * THE CHART RULE, in one place so the two variants cannot silently share one.
 *
 * CONTINUOUS → total. A 1200m has a real total time and the laps are its
 * breakdown. Comparability across sessions is already handled by the drill label
 * carrying the distance, so every point in a series has the same lap count. The
 * total also accumulates no start error: there is exactly ONE start, and it is a
 * gate edge.
 *
 * REST → mean. The sum of 3x400 with recovery is not a time anybody ran, and it
 * is the wrong quantity for a second reason: every rep is hand-started, so a sum
 * accumulates the ~200ms tap error ONCE PER REP (3x400 ⇒ ~600ms of bias) while
 * the mean carries roughly one rep's worth however many reps there are. The mean
 * is also what a coach says out loud — "he averaged 64s".
 */
export function chartValueMs(set: RepSet): number {
  return set.variant === 'continuous' ? set.totalMs : set.meanMs;
}

/** A rep set as it comes back out of `runs.raw_json`. */
export type SavedRepSet = {
  variant: RepeatVariant;
  /** interval times in ms, in order */
  intervals: number[];
  targetLaps: number | null;
  exact: boolean;
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
    return { variant, intervals, targetLaps, exact: v.exact === true };
  } catch {
    return null;
  }
}

/** The chart value for a SAVED rep set — the same rule as chartValueMs, applied
 *  to storage, so the graph cannot drift from what the screen showed at save time.
 *  Returns null when the row is not a rep set. */
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
 * Pure — no React, no BLE. The provider feeds it every parsed v2 frame via
 * ingest() and the screen drives arm()/startRep()/end().
 */
export class RepeatEngine {
  state: RepeatState = 'idle';
  config: RepeatConfig;
  intervals: RepInterval[] = [];

  /** planned lap/rep count for the live set, or null. Never ends anything. */
  targetLaps: number | null = null;
  /** gate micros of the open interval's start (CONTINUOUS) */
  private openUs = 0;
  /** phone ms of the open interval's start (REST — a tap, so phone clock) */
  private openAtMs = 0;
  private startedAtMs = 0;

  onInterval: ((interval: RepInterval, count: number) => void) | null = null;
  onOpen: ((atMs: number) => void) | null = null;

  constructor(config: RepeatConfig) {
    this.config = config;
  }

  /** Swap variant / retune the lockout. Takes effect on the next arm(); changing
   *  it mid-set would make the intervals already collected mean something else. */
  setConfig(config: RepeatConfig): void {
    if (this.state !== 'idle') return;
    this.config = config;
  }

  /** Begin a set. CONTINUOUS waits for the first crossing; REST waits for a tap. */
  arm(atMs: number, targetLaps: number | null = null): void {
    this.intervals = [];
    this.targetLaps = targetLaps && targetLaps > 0 ? Math.round(targetLaps) : null;
    this.startedAtMs = atMs;
    this.openUs = 0;
    this.openAtMs = 0;
    this.state = this.config.variant === 'continuous' ? 'armed' : 'resting';
  }

  /** REST only: the coach taps, the athlete goes. Ignored in CONTINUOUS, where
   *  the gate decides when an interval opens. */
  startRep(atMs: number): void {
    if (this.config.variant !== 'rest') return;
    if (this.state !== 'resting') return;
    this.openAtMs = atMs;
    this.state = 'running';
    this.onOpen?.(atMs);
  }

  /** Abandon without producing a set. */
  reset(): void {
    this.state = 'idle';
    this.intervals = [];
  }

  /**
   * Close the set. The interval currently OPEN is discarded: in CONTINUOUS it is
   * the stretch after the last crossing with no closing crossing, and in REST it
   * is a rep the athlete never finished. Neither is a time.
   */
  end(atMs: number): RepSet {
    const intervals = this.intervals;
    this.state = 'idle';
    this.intervals = [];
    return {
      variant: this.config.variant,
      gateId: this.config.gateId,
      targetLaps: this.targetLaps,
      intervals,
      ...summarize(intervals),
      lockoutMs: this.config.lockoutMs,
      // CONTINUOUS is intra-clock at both ends. REST starts on a hand tap, so it
      // is not, however precise the closing edge is.
      exact: this.config.variant === 'continuous',
      startedAtMs: this.startedAtMs,
      endedAtMs: atMs,
    };
  }

  /** Route one parsed frame. Returns the interval this frame closed, if any. */
  ingest(frame: V2Frame, atMs: number): RepInterval | null {
    if (frame.kind !== 'beam' || frame.edge !== 'break') return null;
    if (frame.gateId !== this.config.gateId) return null;

    const { variant, lockoutMs } = this.config;

    // CONTINUOUS: the first crossing is t0 and closes nothing.
    if (variant === 'continuous' && this.state === 'armed') {
      this.openUs = frame.micros;
      this.openAtMs = atMs;
      this.state = 'running';
      this.onOpen?.(atMs);
      return null;
    }

    if (this.state !== 'running') return null;

    if (variant === 'continuous') {
      // Gate clock at both ends: exact, wrap-safe.
      if (!passedLockoutUs(frame.micros, this.openUs, lockoutMs)) return null;
      const interval: RepInterval = {
        ms: Math.round(sdiff32(frame.micros, this.openUs) / 1000),
        closeUs: frame.micros,
        closeAtMs: atMs,
        startSource: 'gate',
      };
      // The close of this lap is the open of the next — no gap between intervals.
      this.openUs = frame.micros;
      this.openAtMs = atMs;
      this.intervals.push(interval);
      this.onInterval?.(interval, this.intervals.length);
      return interval;
    }

    // REST: opened by a tap, so the whole interval is measured on the PHONE clock.
    // Mixing a phone start with a gate close would need the sync offset for ~20ms
    // of BLE delivery jitter, which is noise beside the ~200ms tap error it sits
    // on top of. One clock, honestly labelled, beats two clocks and a correction.
    if (!passedLockoutMs(atMs, this.openAtMs, lockoutMs)) return null;
    const interval: RepInterval = {
      ms: atMs - this.openAtMs,
      closeUs: frame.micros,
      closeAtMs: atMs,
      startSource: 'tap',
    };
    this.state = 'resting'; // rest begins, and is outside every interval
    this.intervals.push(interval);
    this.onInterval?.(interval, this.intervals.length);
    return interval;
  }
}
