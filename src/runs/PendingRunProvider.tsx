// Holds the discard window (src/runs/pending.ts) and owns the two guards that
// can't live in a screen: the app backgrounding, and the gates dropping.
//
// Sits INSIDE both BLE providers so it can watch the link, and inside RosterProvider
// so a discard can put the athlete back up. All the RULES are in ./pending (pure,
// verified by scripts/verify-pending.mjs); this file is wiring and side effects.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AppState } from 'react-native';

import { useGate } from '../ble/GateProvider';
import { useV2 } from '../ble/V2Provider';
import { deleteRun } from '../db/database';
import { useRoster } from '../roster/RosterProvider';
import {
  EMPTY_PENDING,
  clearReason,
  offer,
  settle,
  type PendingRun,
  type PendingState,
  type SettleReason,
} from './pending';

/** How long "Run discarded" stays on screen. This is a confirmation, not a window —
 *  the window itself has no timer. */
const CONFIRM_MS = 2500;

type PendingRunContextValue = {
  state: PendingState;
  /** Call immediately after saveRun() resolves. Standalone runs are ignored by
   *  the rules in ./pending, so callers pass them through unconditionally. */
  offerRun: (run: PendingRun) => void;
  /** The next rep has STARTED. Screens call this from their run-start path. */
  settleForNextRep: () => void;
  /** Delete the pending run and put its athlete back up. */
  discard: () => Promise<void>;
};

const PendingRunContext = createContext<PendingRunContextValue | null>(null);

export function PendingRunProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PendingState>(EMPTY_PENDING);
  const roster = useRoster();
  const v2 = useV2();
  const gate = useGate();

  // RosterProvider's context value is rebuilt each render, so holding the function
  // in a ref keeps this component's callbacks stable instead of churning.
  const revertRef = useRef(roster.revertAdvance);
  revertRef.current = roster.revertAdvance;

  // Either engine counts: v1 uses GateProvider, v2/Drills use V2Provider, and the
  // OR means "some gate link is still up" without this file needing to know which
  // engine saved the run.
  const liveNow = v2.connected || gate.status === 'connected';
  // Whether the link was up when the window opened. A run offered while already
  // disconnected (manual entry, replay) must not be settled by that same fact.
  const liveAtOffer = useRef(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const close = useCallback((reason: SettleReason) => {
    setState((s) => settle(s, reason));
  }, []);

  const offerRun = useCallback(
    (run: PendingRun) => {
      liveAtOffer.current = liveNow;
      setState((s) => offer(s, run));
    },
    [liveNow],
  );

  // GUARD: the gates dropped. No further reps are coming, so a live discard control
  // would sit there going stale on a run from whenever the link died.
  useEffect(() => {
    if (!state.pending) return;
    if (liveAtOffer.current && !liveNow) close('disconnected');
  }, [liveNow, state.pending, close]);

  // GUARD: the app backgrounded.
  //
  // 'background' only — NOT 'inactive'. iOS fires 'inactive' for the app switcher,
  // Control Centre, and an incoming-call banner: transient states the coach swipes
  // away from in a second, and settling on them would close the window every time
  // a notification slid down.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background') close('backgrounded');
    });
    return () => sub.remove();
  }, [close]);

  // The "Run discarded" confirmation is the only reason worth showing; the rest are
  // the normal flow and would just be noise.
  useEffect(() => {
    if (state.lastReason !== 'discarded') return;
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = setTimeout(() => setState((s) => clearReason(s)), CONFIRM_MS);
    return () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    };
  }, [state.lastReason]);

  const discard = useCallback(async () => {
    const p = state.pending;
    if (!p) return;
    // Close FIRST so a double-tap can't issue two deletes.
    setState((s) => (s.pending?.runId === p.runId ? { pending: null, lastReason: 'discarded' } : s));
    try {
      await deleteRun(p.runId);
      // The rep didn't count, so its athlete is up again rather than having
      // silently lost their turn. No-ops if the coach changed the queue since.
      revertRef.current();
    } catch {
      // Delete failed: the run stands. The window is closed either way — History's
      // delete is the same operation and remains available.
    }
  }, [state.pending]);

  const value: PendingRunContextValue = {
    state,
    offerRun,
    settleForNextRep: useCallback(() => close('next-rep'), [close]),
    discard,
  };

  return <PendingRunContext.Provider value={value}>{children}</PendingRunContext.Provider>;
}

export function usePendingRun(): PendingRunContextValue {
  const ctx = useContext(PendingRunContext);
  if (!ctx) throw new Error('usePendingRun must be used within a PendingRunProvider');
  return ctx;
}
