// Typed parsing of the gate's Event / Status / LastResult payloads.
// Layouts are defined in docs/BLE-CONTRACT.md §5 / §7. All integers are
// little-endian; result times are uint32 milliseconds (rounded at the source).

import { Evt, GateState } from './constants';

function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

export type GateEvent =
  | { type: Evt.State; seq: number; state: GateState; mode: number }
  | { type: Evt.Countdown; seq: number; phase: number }
  | { type: Evt.Go; seq: number; mode: number; t0us: number }
  | { type: Evt.Start; seq: number; mode: number; t0us: number }
  | { type: Evt.Split; seq: number; mode: number; index: number; splitMs: number }
  | {
      type: Evt.Finish;
      seq: number;
      mode: number;
      totalMs: number;
      split1Ms: number;
      split2Ms: number;
      flags: number;
    }
  | { type: Evt.Notice; seq: number; code: number };

export function parseEvent(b: Uint8Array): GateEvent | null {
  if (b.length < 2) return null;
  const type = b[0];
  const seq = b[1];
  const p = b.subarray(2);
  switch (type) {
    case Evt.State:
      return { type, seq, state: p[0] as GateState, mode: p[1] };
    case Evt.Countdown:
      return { type, seq, phase: p[0] };
    case Evt.Go:
      return { type, seq, mode: p[0], t0us: u32(p, 1) };
    case Evt.Start:
      return { type, seq, mode: p[0], t0us: u32(p, 1) };
    case Evt.Split:
      return { type, seq, mode: p[0], index: p[1], splitMs: u32(p, 2) };
    case Evt.Finish:
      return {
        type,
        seq,
        mode: p[0],
        totalMs: u32(p, 1),
        split1Ms: u32(p, 5),
        split2Ms: u32(p, 9),
        flags: p[13] ?? 0,
      };
    case Evt.Notice:
      return { type, seq, code: p[0] };
    default:
      return null;
  }
}

export type GateStatus = {
  protoVer: number;
  state: GateState;
  mode: number;
  runCount: number;
  finishLinkOk: boolean;
  gateMicros: number;
};

export function parseStatus(b: Uint8Array): GateStatus | null {
  if (b.length < 9) return null;
  return {
    protoVer: b[0],
    state: b[1] as GateState,
    mode: b[2],
    runCount: b[3],
    finishLinkOk: b[4] === 1,
    gateMicros: u32(b, 5),
  };
}

export type LastResult = {
  mode: number;
  totalMs: number;
  split1Ms: number;
  split2Ms: number;
  flags: number;
  runIndex: number;
};

export function parseLastResult(b: Uint8Array): LastResult | null {
  if (b.length < 15) return null;
  return {
    mode: b[0],
    totalMs: u32(b, 1),
    split1Ms: u32(b, 5),
    split2Ms: u32(b, 9),
    flags: b[13],
    runIndex: b[14],
  };
}
