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
  // Empirical clock-sync jitter: stdev of the per-sample implied offset across the
  // better-RTT half. A small value means the samples agree on the offset; it does
  // NOT capture a constant path asymmetry (that bias is bounded by minRttMs/2).
  offsetSpreadMs: number;
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
  // Implied offset (gate - phone) per sample = gateUs/1000 - midPhoneMs. The
  // stdev across the better half is the observed sync jitter. Subtract the mean
  // first for float precision (absolute offsets are large).
  const half = byRtt.slice(0, Math.max(1, Math.ceil(byRtt.length / 2)));
  const offsets = half.map((s) => s.gateUs / 1000 - s.midPhoneMs);
  const mean = offsets.reduce((a, b) => a + b, 0) / offsets.length;
  const offsetSpreadMs =
    offsets.length > 1
      ? Math.sqrt(offsets.reduce((a, b) => a + (b - mean) ** 2, 0) / offsets.length)
      : 0;
  return {
    anchor: { g0Us: best.gateUs, p0Ms: best.midPhoneMs },
    minRttMs: best.rttMs,
    medianRttMs: byRtt[Math.floor(byRtt.length / 2)].rttMs,
    maxRttMs: byRtt[byRtt.length - 1].rttMs,
    offsetSpreadMs,
    samples: byRtt.length,
  };
}
