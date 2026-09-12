// Fabricated hardware state, for taking App Store screenshots in the Simulator.
//
// NOT A FEATURE. The Simulator has no Bluetooth and no camera, so the screens that
// matter most — a connected gate, a set badge, a ready session — cannot be made to
// render with real data. This substitutes plausible values for exactly those, and
// nothing else.
//
// WHY NOT THE DEV-MODE TOGGLE, which was the obvious place to put it:
//
//   1. Dev mode is a RUNTIME switch that ships. A build that can be talked into
//      claiming a gate is connected when none is, is a build that can mislead, and
//      "it is behind a toggle" is not much of an answer if a reviewer finds the
//      toggle. `__DEV__` is compile-time: it is false in any release build and the
//      minifier removes the dead branch entirely, so this cannot exist in the
//      binary that goes to App Store Connect.
//
//   2. Dev mode is used at MEETS, on real hardware. Tying this to it would mean
//      that turning on diagnostics next to a live gate replaced the real
//      connection with a fake one — the worst possible moment for it.
//
// So it takes BOTH a development build and an explicit launch flag:
//
//     EXPO_PUBLIC_DEMO=1 npx expo start
//
// EXPO_PUBLIC_* is inlined at bundle time, so an ordinary `npx expo start` on a
// debug build is untouched. There is no way to switch this on from inside the app,
// which is deliberate: there is nothing to leave on by accident.

import { PROTO_VERSION } from '../ble/constants';
import { GateState } from '../ble/constants';
import type { GateStatus } from '../ble/events';

/** True only in a development bundle launched with the demo flag. */
export const DEMO = __DEV__ && process.env.EXPO_PUBLIC_DEMO === '1';

/**
 * A gate sitting idle and ready, with a practice already under way.
 *
 * runCount is non-zero because a screenshot of a gate that has never been used is a
 * screenshot of an empty app; finishLinkOk is true because the warning triangle it
 * otherwise draws is the one thing on that row a coach should never see in a store
 * listing.
 */
export const DEMO_GATE_STATUS: GateStatus = {
  protoVer: PROTO_VERSION,
  state: GateState.Idle,
  mode: 1,
  runCount: 6,
  finishLinkOk: true,
  gateMicros: 4_620_000_000,
};

/** Plausible sync numbers: a good link, not a suspiciously perfect one. */
export const DEMO_CLOCK_SYNC = {
  anchor: { g0Us: 4_620_000_000, p0Ms: 0 },
  minRttMs: 31.2,
  medianRttMs: 38.9,
  maxRttMs: 52.4,
  offsetSpreadMs: 1.8,
  samples: 12,
};

/** Two gates of set 1, both time-synced — what "Both gates ready" is read from. */
export const DEMO_GATES = [
  {
    id: 1,
    mac: 'A4:CF:12:9B:04:11',
    role: 'start' as const,
    hasDisplay: true,
    timeSynced: true,
    thresholdCm: 120,
    setNumber: 1,
    rebootPending: false,
  },
  {
    id: 2,
    mac: 'A4:CF:12:9B:04:2E',
    role: 'finish' as const,
    hasDisplay: false,
    timeSynced: true,
    thresholdCm: 120,
    setNumber: 1,
    rebootPending: false,
  },
];
