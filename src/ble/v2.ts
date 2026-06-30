// v2 raw-event pipeline (consumer side). Parses the gate's 7-byte event frames,
// reply frames, and heartbeats (docs/BLE-CONTRACT.md §7/§9/§10), and runs the
// APP-OWNED interpretation: a Mode-1 run engine that pairs BEAM_BREAK edges
// across gates and computes the split with wrap-safe modular subtraction.
//
// This is ADDITIVE: v2 frames arrive on the SAME Event characteristic the v1
// pipeline already monitors, and parseV2Frame returns null for v1 frames (their
// type bytes are disjoint), so the two pipelines never collide. Behind a dev
// flag the app runs this alongside v1 to compare the two splits live (§14).

import { sdiff32 } from './clockSync';
import {
  V2Evt,
  V2Link,
  V2Reply,
  CAP_HAS_DISPLAY,
  CAP_HAS_BUTTONS,
  CAP_BUZZER_WIRED,
  CAP_TIME_SYNCED,
  V2Cmd,
} from './v2constants';

function u16(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8)) & 0xffff;
}
function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}
function putU32(b: Uint8Array, o: number, v: number): void {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
  b[o + 2] = (v >>> 16) & 0xff;
  b[o + 3] = (v >>> 24) & 0xff;
}
function macHex(b: Uint8Array, o: number): string {
  return Array.from(b.subarray(o, o + 6))
    .map((x) => x.toString(16).padStart(2, '0'))
    .join(':');
}

// ---------------------------------------------------------------------------
// Frame parsing
// ---------------------------------------------------------------------------

export type V2Caps = {
  hasDisplay: boolean;
  hasButtons: boolean;
  buzzerWired: boolean;
  timeSynced: boolean;
};

export type V2Frame =
  | { kind: 'beam'; edge: 'break' | 'clear'; gateId: number; micros: number; flags: number }
  | { kind: 'buzzer'; gateId: number; micros: number; flags: number }
  | { kind: 'button'; gateId: number; micros: number; flags: number }
  | { kind: 'heartbeat'; mac: string }
  | { kind: 'pingReply'; appMicros: number; gateMicros: number }
  | {
      kind: 'status';
      gateId: number;
      thresholdCm: number;
      batteryPct: number;
      queueDepth: number;
      fwVer: number;
      caps: V2Caps;
    };

function parseCaps(c: number): V2Caps {
  return {
    hasDisplay: (c & CAP_HAS_DISPLAY) !== 0,
    hasButtons: (c & CAP_HAS_BUTTONS) !== 0,
    buzzerWired: (c & CAP_BUZZER_WIRED) !== 0,
    timeSynced: (c & CAP_TIME_SYNCED) !== 0,
  };
}

/** Parse one raw notification as a v2 frame. Returns null for v1/unknown frames
 *  (their type bytes are disjoint from v2's), so it is safe to call on EVERY
 *  Event notification and route by the result. */
export function parseV2Frame(b: Uint8Array): V2Frame | null {
  if (b.length < 1) return null;
  const type = b[0];
  switch (type) {
    case V2Evt.BeamBreak:
    case V2Evt.BeamClear:
      if (b.length < 7) return null;
      return {
        kind: 'beam',
        edge: type === V2Evt.BeamBreak ? 'break' : 'clear',
        gateId: b[1],
        micros: u32(b, 2),
        flags: b[6],
      };
    case V2Evt.BuzzerFired:
      if (b.length < 7) return null;
      return { kind: 'buzzer', gateId: b[1], micros: u32(b, 2), flags: b[6] };
    case V2Evt.ButtonPress:
      if (b.length < 7) return null;
      return { kind: 'button', gateId: b[1], micros: u32(b, 2), flags: b[6] };
    case V2Link.Heartbeat:
      if (b.length < 7) return null;
      return { kind: 'heartbeat', mac: macHex(b, 1) };
    case V2Reply.PingReply:
      if (b.length < 9) return null;
      return { kind: 'pingReply', appMicros: u32(b, 1), gateMicros: u32(b, 5) };
    case V2Reply.StatusReply:
      if (b.length < 8) return null;
      return {
        kind: 'status',
        gateId: b[1],
        thresholdCm: u16(b, 2),
        batteryPct: b[4],
        queueDepth: b[5],
        fwVer: b[6],
        caps: parseCaps(b[7]),
      };
    default:
      return null; // v1 frame or reserved/unknown — not ours
  }
}

// ---------------------------------------------------------------------------
// Command builders (phone → gate, on the Command characteristic)
// ---------------------------------------------------------------------------

/** PING (0x34) — connected gate only, no target. app_micros echoed back so the
 *  app can match reply↔request and compute RTT for the display offset. */
export function buildPing(appMicros: number): Uint8Array {
  const f = new Uint8Array(5);
  f[0] = V2Cmd.Ping;
  putU32(f, 1, appMicros >>> 0);
  return f;
}

/** GET_STATUS (0x35) — target gate(s) reply STATUS_REPLY. */
export function buildGetStatus(target: number): Uint8Array {
  return new Uint8Array([V2Cmd.GetStatus, target & 0xff]);
}

/** CLEAR_QUEUE (0x33) — target gate(s) empty the RAM event ring (session start). */
export function buildClearQueue(target: number): Uint8Array {
  return new Uint8Array([V2Cmd.ClearQueue, target & 0xff]);
}

/** SET_THRESHOLD (0x31) — target gate(s) set RAM threshold_cm. */
export function buildSetThreshold(target: number, distanceCm: number): Uint8Array {
  const d = distanceCm & 0xffff;
  return new Uint8Array([V2Cmd.SetThreshold, target & 0xff, d & 0xff, (d >>> 8) & 0xff]);
}

/** BUZZER_FIRE (0x32) — target gate drives the buzzer, emits BUZZER_FIRED. */
export function buildBuzzerFire(target: number, durationMs: number, pattern = 0): Uint8Array {
  const dur = durationMs & 0xffff;
  return new Uint8Array([V2Cmd.BuzzerFire, target & 0xff, dur & 0xff, (dur >>> 8) & 0xff, pattern & 0xff]);
}

/** ASSIGN_IDS (0x30) — count, then count×{mac:6, id:1}. The MAC list IS the
 *  targeting; each gate sets its id on a MAC match (§8). 2 gates = 16 bytes. */
export function buildAssignIds(entries: { mac: Uint8Array; id: number }[]): Uint8Array {
  const f = new Uint8Array(2 + entries.length * 7);
  f[0] = V2Cmd.AssignIds;
  f[1] = entries.length & 0xff;
  let p = 2;
  for (const e of entries) {
    f.set(e.mac.subarray(0, 6), p);
    f[p + 6] = e.id & 0xff;
    p += 7;
  }
  return f;
}

// ---------------------------------------------------------------------------
// Mode-1 run engine (APP-OWNED, §12) — pure, no React/BLE dependency
// ---------------------------------------------------------------------------

export type V2Run = {
  startGateId: number;
  finishGateId: number;
  startUs: number;
  finishUs: number;
  /** sdiff32(finishUs, startUs)/1000, rounded — wrap-safe across the ~71.6 min
   *  uint32 rollover. The number is only trustworthy when `synced` is true. */
  splitMs: number;
  /** Both gates in the shared clock? Cross-gate splits are withheld until true
   *  (§4). The start gate is the time master (always synced); the finish gate's
   *  flag comes from its STATUS_REPLY caps. */
  synced: boolean;
  startAtMs: number;
  finishAtMs: number;
};

export type V2EngineState = 'idle' | 'armed' | 'running';

/**
 * Mode 1: the first BEAM_BREAK on the start gate starts the run; the first
 * BEAM_BREAK on the finish gate completes it. BEAM_CLEAR is ignored. Additional
 * breaks on the active gate during a phase are ignored (edge pairing). The
 * caller arms the engine; on completion it returns to `idle` for the next arm.
 */
export class V2RunEngine {
  state: V2EngineState = 'idle';
  startGateId: number;
  finishGateId: number;
  /** Per-gate time-sync status, set from STATUS_REPLY caps. Unknown => false
   *  (withhold the split until a status confirms the gate is synced). */
  private synced = new Map<number, boolean>();
  private startUs = 0;
  private startAtMs = 0;
  /** Optional sink for completed runs (e.g. the dev comparison view). */
  onRun: ((run: V2Run) => void) | null = null;

  constructor(startGateId = 1, finishGateId = 2) {
    this.startGateId = startGateId;
    this.finishGateId = finishGateId;
  }

  arm(): void {
    this.state = 'armed';
  }

  reset(): void {
    this.state = 'idle';
  }

  /** Record a gate's time-sync capability (from a STATUS_REPLY). */
  setSynced(gateId: number, synced: boolean): void {
    this.synced.set(gateId, synced);
  }

  /** Convenience: route a parsed frame. Status updates sync state; beam breaks
   *  drive the run engine. Returns a completed run if this frame finished one. */
  ingest(frame: V2Frame, atMs: number): V2Run | null {
    if (frame.kind === 'status') {
      this.setSynced(frame.gateId, frame.caps.timeSynced);
      return null;
    }
    if (frame.kind === 'beam' && frame.edge === 'break') {
      return this.onBeamBreak(frame.gateId, frame.micros, atMs);
    }
    return null; // clear/buzzer/button/heartbeat/pingReply are not run-driving here
  }

  onBeamBreak(gateId: number, micros: number, atMs: number): V2Run | null {
    if (this.state === 'armed' && gateId === this.startGateId) {
      this.startUs = micros;
      this.startAtMs = atMs;
      this.state = 'running';
      return null;
    }
    if (this.state === 'running' && gateId === this.finishGateId) {
      const splitUs = sdiff32(micros, this.startUs);
      const run: V2Run = {
        startGateId: this.startGateId,
        finishGateId: this.finishGateId,
        startUs: this.startUs,
        finishUs: micros,
        splitMs: Math.round(splitUs / 1000),
        // start gate is the master (default true if we have no status for it)
        synced: (this.synced.get(this.startGateId) ?? true) && (this.synced.get(this.finishGateId) ?? false),
        startAtMs: this.startAtMs,
        finishAtMs: atMs,
      };
      this.state = 'idle';
      this.onRun?.(run);
      return run;
    }
    return null;
  }
}
