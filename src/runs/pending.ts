// The discard window: which run the discard control is currently pointing at.
//
// Pure — no React, no SQLite, no imports. Verified by scripts/verify-pending.mjs.
//
// The window is NOT on a timer. It stays open until the next rep starts, because a
// fixed duration means glancing away costs you the chance to bin a bad rep. What
// closes it instead is any event that means "you are no longer looking at this run":
// the next rep, an explicit dismiss, the gates dropping, or the app backgrounding.
//
// Closing the window KEEPS the run. The run was written durably the moment it
// finished (see saveRun) — discard is a delete by id, never a deferred insert — so
// every close path is safe by default and only the explicit discard destroys data.

export type SettleReason =
  /** the next rep started — the previous run is history now */
  | 'next-rep'
  /** the coach cleared it by hand, which also MEANS "keep this run" */
  | 'dismissed'
  /** a newer run took the window */
  | 'superseded'
  /** gates dropped: no more reps are coming, so a live control would go stale */
  | 'disconnected'
  /** app backgrounded: whatever is on screen when it returns is not this run */
  | 'backgrounded'
  /** the run was actually deleted */
  | 'discarded';

export type PendingRun = {
  runId: string;
  totalMs: number;
  /** null = Unassigned. Named on the control so it can't delete the wrong run. */
  athleteName: string | null;
  drillName: string | null;
  /**
   * A standalone (B1) run — the gate timed it with nobody driving the phone.
   *
   * These never take the window and never close one. The window is an affordance
   * for "the rep I just watched"; a B1 run is a log entry that arrived on its own.
   * Letting it steal the window would point the discard control at a run the coach
   * never saw, right as they reach for it. Consistent with B1 runs already saving
   * Unassigned and not advancing the queue.
   */
  standalone: boolean;
  savedAt: number;
};

export type PendingState = {
  pending: PendingRun | null;
  /** why the last window closed — drives the brief confirmation line */
  lastReason: SettleReason | null;
};

export const EMPTY_PENDING: PendingState = { pending: null, lastReason: null };

/** A run just saved. Returns the new state. */
export function offer(state: PendingState, run: PendingRun): PendingState {
  if (run.standalone) return state;
  // Re-offering the same run (a re-render, a retry) must not read as a supersede.
  if (state.pending && state.pending.runId === run.runId) return state;
  return { pending: run, lastReason: state.pending ? 'superseded' : null };
}

/** Close the window, KEEPING the run. Inert when nothing is pending. */
export function settle(state: PendingState, reason: SettleReason): PendingState {
  if (!state.pending) return state;
  return { pending: null, lastReason: reason };
}

/** Drop the "kept/discarded" confirmation line once it has been shown. */
export function clearReason(state: PendingState): PendingState {
  return state.lastReason == null ? state : { ...state, lastReason: null };
}

export function isOpen(state: PendingState): boolean {
  return state.pending != null;
}

/** What the discard control says it will delete. Never just "Discard": with the
 *  window moving to the newest run, an unlabelled button is one glance away from
 *  binning the wrong rep. */
export function describe(run: PendingRun): string {
  const secs = `${(run.totalMs / 1000).toFixed(2)}s`;
  return [secs, run.athleteName, run.drillName].filter(Boolean).join(' · ');
}
