// Lockout primitives shared by the interval engines.
//
// A lockout answers one question: "is this beam break far enough after the last
// reference to be a NEW crossing, rather than the same body still passing
// through?" A limb swinging through the beam produces several break/clear pairs;
// without this, one athlete crossing once counts as three.
//
// NOT yet adopted by drills.ts. L Drill and Shuttle Run carry the same test
// inline, and they are hardware-validated with no automated coverage — a purely
// mechanical extraction there is low risk but not zero, and "don't change what
// works" outranks removing four duplicated lines. Adopting it is a one-line swap
// whenever those get a verify script of their own.

import { sdiff32 } from './clockSync';

export type LockoutBounds = { minMs: number; maxMs: number; stepMs: number };

/** Keep a stepper from pushing a nonsensical value. Unknown key → just sanitise. */
export function clampToBounds(b: LockoutBounds | undefined, ms: number): number {
  if (!b) return Math.max(0, Math.round(ms));
  return Math.min(b.maxMs, Math.max(b.minMs, Math.round(ms)));
}

/**
 * GATE-clock test, wrap-safe across the ~71.6 min uint32 micros rollover.
 *
 * An out-of-order frame gives a negative difference, which fails the comparison
 * and is swallowed — the desired behaviour, and free rather than special-cased.
 */
export function passedLockoutUs(micros: number, lastRefUs: number, lockoutMs: number): boolean {
  return sdiff32(micros, lastRefUs) >= lockoutMs * 1000;
}

/** PHONE-clock test, for an interval whose start was a screen tap rather than a
 *  gate edge. Same swallow-on-negative property. */
export function passedLockoutMs(atMs: number, lastRefMs: number, lockoutMs: number): boolean {
  return atMs - lastRefMs >= lockoutMs;
}
