// App-owned drill engine (v2 raw-event pipeline). ONE parameterized state machine
// covers both event drills; the firmware is untouched (frozen-candidate g1-a3) —
// it emits BEAM_BREAK/BEAM_CLEAR edges, this owns all meaning, exactly like the
// Mode-1 V2RunEngine (v2.ts). Two drills, one shape (docs/DRILLS.md):
//
//   L Drill    : start = gate 1 CLEAR (hand lifts). Count 1 break on gate 2, but
//                only after a grace window (the runner passes gate 2 early — that
//                pass is inside the grace and ignored; the final pass stops it).
//   Shuttle    : start = gate 1 CLEAR (runner leaves the middle). Count 2 breaks
//                on gate 1; a lockout between counted breaks so one body crossing
//                (a limb swinging through = several break/clear pairs) is ONE pass.
//
// The unifying model:
//   • the START is a CLEAR on the start gate, gated by a "loaded" step so a start
//     reflects a real in-beam → out-of-beam transition (not a stray clear);
//   • then count BREAKs on the count gate; a break counts only when it is at least
//     `lockoutMs` after the previous reference (t0 for the first, the last counted
//     break thereafter). Inside the lockout → swallowed. Nth counted break = stop.
//
// All interval math is sdiff32 (wrap-safe across the ~71.6 min uint32 rollover),
// identical to Mode 1. A single-gate drill (shuttle: start gate == count gate)
// is intra-clock so its result is exact with no cross-gate sync; a two-gate drill
// (L: gate 1 → gate 2) needs both gates time-synced, same as a Mode-1 split.

import { sdiff32 } from './clockSync';
import type { V2Frame } from './v2';

/** History `mode` for every app-parameterized drill. The specific drill is carried
 *  by `drill_type` (the label), which is what History groups/averages on — so one
 *  mode is correct and future-proof (a new drill = a new label, not a new mode). */
export const DRILL_MODE = 3;

export type DrillConfig = {
  /** stable id — persistence key for the tuned lockout; never shown. */
  key: string;
  /** human label — the History `drill_type` and the UI title. */
  label: string;
  /** gate whose CLEAR (leaving the beam) starts the run. */
  startGateId: number;
  /** gate whose BREAKs are counted toward the finish. */
  countGateId: number;
  /** number of counted breaks that stops the timer. */
  countN: number;
  /** minimum gap (ms) from the previous reference before a break counts:
   *  t0 for the first counted break, the last counted break thereafter. This is
   *  BOTH the L-drill "grace window from the start" and the shuttle "one crossing
   *  can't be two passes" debounce — the same parameter, two framings. */
  lockoutMs: number;
};

// Defaults (Louis's starting numbers; tuned live in the UI against real athletes).
export const DRILL_L_DRILL: DrillConfig = {
  key: 'l-drill',
  label: 'L Drill',
  startGateId: 1,
  countGateId: 2,
  countN: 1,
  lockoutMs: 6000,
};
export const DRILL_SHUTTLE: DrillConfig = {
  key: 'shuttle',
  label: 'Shuttle Run',
  startGateId: 1,
  countGateId: 1,
  countN: 2,
  lockoutMs: 1000,
};
export const DRILLS: DrillConfig[] = [DRILL_L_DRILL, DRILL_SHUTTLE];

// Live-tuning bounds per drill key, so a stepper can't push a nonsensical value.
export const LOCKOUT_BOUNDS: Record<string, { minMs: number; maxMs: number; stepMs: number }> = {
  'l-drill': { minMs: 1000, maxMs: 20000, stepMs: 500 },
  shuttle: { minMs: 300, maxMs: 4000, stepMs: 100 },
};
export function clampLockout(key: string, ms: number): number {
  const b = LOCKOUT_BOUNDS[key];
  if (!b) return Math.max(0, Math.round(ms));
  return Math.min(b.maxMs, Math.max(b.minMs, Math.round(ms)));
}

// idle    — not armed.
// armed   — waiting for the athlete to get INTO the start beam (loaded).
// set     — athlete is in the start beam; leaving it starts the run.
// running — counting breaks on the count gate toward countN.
// A finished run returns to 'idle' (result carried by the emitted DrillRun),
// mirroring V2RunEngine so the screen's result view is the same pattern.
export type DrillState = 'idle' | 'armed' | 'set' | 'running';

export type DrillRun = {
  configKey: string;
  label: string;
  startUs: number;
  finishUs: number;
  /** sdiff32(finishUs, startUs)/1000, rounded — wrap-safe. Trust only when synced. */
  splitMs: number;
  /** single-gate drill => always true (intra-clock); two-gate => both synced. */
  synced: boolean;
  /** counted breaks at finish (== countN on a real finish). */
  counted: number;
  countN: number;
  lockoutMs: number;
  startAtMs: number;
  finishAtMs: number;
};

/**
 * Pure — no React, no BLE. The provider feeds it every parsed v2 frame via
 * ingest() and wires the callbacks; the screen renders off provider state.
 */
export class DrillEngine {
  state: DrillState = 'idle';
  config: DrillConfig;
  /** Per-gate time-sync (from STATUS_REPLY caps), same source as V2RunEngine. */
  private synced = new Map<number, boolean>();
  /** Live state of the START beam, tracked ALWAYS (even idle) so arm() can seed
   *  'set' when the athlete is already standing in the beam (the shuttle case). */
  private startBroken = false;
  private startUs = 0;
  private startAtMs = 0;
  private counted = 0;
  /** reference for the next lockout test: t0, then each counted break. */
  private lastRefUs = 0;

  onStart: ((startUs: number, startAtMs: number) => void) | null = null;
  onCount: ((counted: number, countN: number) => void) | null = null;
  onRun: ((run: DrillRun) => void) | null = null;

  constructor(config: DrillConfig) {
    this.config = config;
  }

  /** Swap the active drill / retune the lockout. Takes effect on the next arm().
   *  Safe any time: it does not clear the live start-beam tracking (both drills
   *  share the same start gate), so a mid-idle switch keeps a correct 'set' seed. */
  setConfig(config: DrillConfig): void {
    this.config = config;
  }

  setSynced(gateId: number, synced: boolean): void {
    this.synced.set(gateId, synced);
  }

  arm(): void {
    this.counted = 0;
    // Seed 'set' from the live start-beam state: a runner already in the beam at
    // arm (shuttle, staged in the middle) gets no fresh break edge, so without
    // this seed their leaving would be missed. If the beam is clear, wait for the
    // athlete to enter (a real break) — which also discards a walk-up artifact
    // that happened before they settled (arm once the athlete is set and still).
    this.state = this.startBroken ? 'set' : 'armed';
  }

  reset(): void {
    this.state = 'idle';
    this.counted = 0;
  }

  /** Route one parsed frame. STATUS updates sync; BEAM edges drive the machine.
   *  Returns a completed DrillRun if this frame finished one (also via onRun). */
  ingest(frame: V2Frame, atMs: number): DrillRun | null {
    if (frame.kind === 'status') {
      this.setSynced(frame.gateId, frame.caps.timeSynced);
      return null;
    }
    if (frame.kind !== 'beam') return null;

    // Track the start beam's live state on every start-gate edge, in every state.
    if (frame.gateId === this.config.startGateId) {
      this.startBroken = frame.edge === 'break';
    }
    return this.onBeam(frame.edge, frame.gateId, frame.micros, atMs);
  }

  private onBeam(
    edge: 'break' | 'clear',
    gateId: number,
    micros: number,
    atMs: number,
  ): DrillRun | null {
    const c = this.config;

    // armed -> set: the athlete enters the start beam (a real in-beam transition).
    if (this.state === 'armed' && gateId === c.startGateId && edge === 'break') {
      this.state = 'set';
      return null;
    }

    // set -> running: the athlete LEAVES the start beam. t0 = that clear.
    if (this.state === 'set' && gateId === c.startGateId && edge === 'clear') {
      this.startUs = micros;
      this.startAtMs = atMs;
      this.lastRefUs = micros;
      this.counted = 0;
      this.state = 'running';
      this.onStart?.(micros, atMs);
      return null;
    }

    // running: count qualifying breaks on the count gate.
    if (this.state === 'running' && gateId === c.countGateId && edge === 'break') {
      const dtUs = sdiff32(micros, this.lastRefUs);
      // Inside the lockout window (from t0, then from the last counted break) →
      // swallow. Negative dt (out-of-order) is < lockout too → also swallowed.
      if (dtUs < c.lockoutMs * 1000) return null;
      this.counted += 1;
      this.lastRefUs = micros;
      this.onCount?.(this.counted, c.countN);
      if (this.counted >= c.countN) {
        const run = this.buildRun(micros, atMs);
        this.state = 'idle';
        this.onRun?.(run);
        return run;
      }
      return null;
    }

    return null;
  }

  private buildRun(finishUs: number, finishAtMs: number): DrillRun {
    const c = this.config;
    const distinctGates = c.startGateId !== c.countGateId;
    const synced = !distinctGates
      ? true // single gate: t0 and finish share one clock → exact, no cross-sync
      : (this.synced.get(c.startGateId) ?? true) && (this.synced.get(c.countGateId) ?? false);
    return {
      configKey: c.key,
      label: c.label,
      startUs: this.startUs,
      finishUs,
      splitMs: Math.round(sdiff32(finishUs, this.startUs) / 1000),
      synced,
      counted: this.counted,
      countN: c.countN,
      lockoutMs: c.lockoutMs,
      startAtMs: this.startAtMs,
      finishAtMs,
    };
  }
}
