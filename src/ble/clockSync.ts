// NTP-style clock sync between the gate's micros() clock and the phone's
// performance.now() clock, so a gate timestamp (t0_us in the GO/START events,
// contract §5) can be mapped into phone time for precise per-run latency
// correction instead of a fixed subtraction.
//
// We anchor on a single PING sample: the gate instant g0Us corresponds to the
// phone instant p0Ms (estimated as the RTT midpoint). Any later gate instant G
// maps to phone time by adding the elapsed gate time. Gate micros is uint32 and
// wraps every ~71.6 min, so elapsed time uses signed 32-bit modular subtraction
// (valid for intervals up to ~35 min — we re-sync each connection).

export type ClockAnchor = { g0Us: number; p0Ms: number };

export type ClockSyncResult = {
  anchor: ClockAnchor;
  minRttMs: number;
  medianRttMs: number;
  maxRttMs: number;
  samples: number;
};

/** Signed 32-bit modular difference a-b, in the same (µs) units. Handles wrap. */
export function sdiff32(a: number, b: number): number {
  let d = (a - b) >>> 0; // uint32
  if (d >= 0x80000000) d -= 0x100000000; // interpret as signed
  return d;
}

/** Map a gate micros() timestamp to phone-clock milliseconds. */
export function gateUsToPhoneMs(gUs: number, anchor: ClockAnchor): number {
  return anchor.p0Ms + sdiff32(gUs, anchor.g0Us) / 1000;
}

export type PingSample = { rttMs: number; gateUs: number; midPhoneMs: number };

/** Build an anchor from PING samples using the minimum-RTT sample (least
 *  queuing asymmetry, NTP best-practice), plus RTT spread for confidence. */
export function buildAnchor(samples: PingSample[]): ClockSyncResult | null {
  if (samples.length === 0) return null;
  const byRtt = [...samples].sort((a, b) => a.rttMs - b.rttMs);
  const best = byRtt[0];
  return {
    anchor: { g0Us: best.gateUs, p0Ms: best.midPhoneMs },
    minRttMs: best.rttMs,
    medianRttMs: byRtt[Math.floor(byRtt.length / 2)].rttMs,
    maxRttMs: byRtt[byRtt.length - 1].rttMs,
    samples: byRtt.length,
  };
}
