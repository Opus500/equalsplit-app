// Minimal decoders used for on-screen logging in step 1. Typed event objects
// (the real app surface) arrive in build-order step 2; this is just readability.

import { Evt, EVT_NAME, STATE_NAME, NOTICE_NAME, PROTO_VERSION } from './constants';

export function u32(b: Uint8Array, o: number): number {
  return ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0);
}

export function toHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join(' ');
}

const secs = (ms: number) => (ms / 1000).toFixed(3) + 's';

export function describeEvent(b: Uint8Array): string {
  if (b.length < 2) return `(${b.length}B) ${toHex(b)}`;
  const type = b[0];
  const seq = b[1];
  const p = b.subarray(2);
  switch (type) {
    case Evt.State:
      return `STATE #${seq} state=${STATE_NAME[p[0]] ?? p[0]} mode=${p[1]}`;
    case Evt.Countdown:
      return `COUNTDOWN #${seq} phase=${p[0]}`;
    case Evt.Go:
      return `GO #${seq} mode=${p[0]} t0_us=${u32(p, 1)}`;
    case Evt.Start:
      return `START #${seq} mode=${p[0]} t0_us=${u32(p, 1)}`;
    case Evt.Split:
      return `SPLIT #${seq} mode=${p[0]} idx=${p[1]} split=${secs(u32(p, 2))}`;
    case Evt.Finish:
      return `FINISH #${seq} mode=${p[0]} total=${secs(u32(p, 1))} s1=${secs(u32(p, 5))} s2=${secs(u32(p, 9))} flags=0x${(p[13] ?? 0).toString(16)}`;
    case Evt.Notice:
      return `NOTICE #${seq} code=${p[0]} (${NOTICE_NAME[p[0]] ?? '?'})`;
    default:
      return `${EVT_NAME[type] ?? '0x' + type.toString(16)} #${seq} ${toHex(p)}`;
  }
}

export function describeStatus(b: Uint8Array): string {
  if (b.length < 9) return `STATUS ${toHex(b)}`;
  const proto = b[0];
  const warn = proto !== PROTO_VERSION ? `  WARN proto ${proto} != ${PROTO_VERSION}` : '';
  return `STATUS proto=${proto} state=${STATE_NAME[b[1]] ?? b[1]} mode=${b[2]} runs=${b[3]} finishLink=${b[4] ? 'OK' : 'DOWN'} gateUs=${u32(b, 5)}${warn}`;
}
