// Practice-queue semantics — PURE. No React, no SQLite, no imports, so the rules
// that decide who runs next can be executed and proven directly
// (scripts/verify-queue.mjs) instead of being inferred from UI behaviour.
//
// The load-bearing decision: the cursor is an ATHLETE ID, never an index.
// An index-based cursor desyncs the instant the lineup is reordered — drag
// someone to the front and the index now points at a different person, so
// somebody runs twice and somebody gets skipped. Storing the id makes that
// class of bug unrepresentable rather than merely tested-for.

export type QueueState = {
  /** the lineup, in order */
  athleteIds: string[];
  /** who is up — an ID, so reordering can never move it to someone else */
  cursorId: string | null;
  /** a one-off jump to someone off-cursor; consumed by the next completed run,
   *  and it never moves the cursor or reorders the lineup */
  overrideId: string | null;
};

export const EMPTY_QUEUE: QueueState = { athleteIds: [], cursorId: null, overrideId: null };

/** Ids currently selectable — i.e. not archived. Archived athletes stay IN the
 *  lineup array (removing them would silently edit the coach's lineup) but are
 *  skipped when choosing who is up. */
export type ActiveSet = ReadonlySet<string>;

function activeOrder(q: QueueState, active: ActiveSet): string[] {
  return q.athleteIds.filter((id) => active.has(id));
}

/** Where the LINEUP is, ignoring any transient override. Falls back to the top
 *  when the cursor's athlete has left the lineup or been archived. */
function cursorAnchorId(q: QueueState, active: ActiveSet): string | null {
  const order = activeOrder(q, active);
  if (order.length === 0) return null;
  if (q.cursorId && order.includes(q.cursorId)) return q.cursorId;
  return order[0];
}

/** Who is up right now: the override if one is pending, else the cursor. */
export function currentAthleteId(q: QueueState, active: ActiveSet): string | null {
  if (q.overrideId && active.has(q.overrideId)) return q.overrideId;
  return cursorAnchorId(q, active);
}

/**
 * The next `count` athletes for the "up next" strip.
 *
 * With an override pending, the cursor athlete has NOT run yet — so they are
 * next, and the lineup shown is unchanged. That is what "overrides the queue
 * position without reordering it" looks like on screen.
 */
export function upNext(q: QueueState, active: ActiveSet, count = 2): string[] {
  const order = activeOrder(q, active);
  if (order.length === 0) return [];
  const current = currentAthleteId(q, active);
  const anchor = cursorAnchorId(q, active);
  if (!anchor) return [];
  const overrideActive = !!(q.overrideId && active.has(q.overrideId));
  const start = overrideActive ? 0 : 1; // override pending => cursor is next
  const i = order.indexOf(anchor);
  const out: string[] = [];
  for (let k = 0; out.length < count && k < order.length; k++) {
    const id = order[(i + start + k) % order.length];
    if (id === current) continue; // never list whoever is currently up
    if (out.includes(id)) break; // wrapped the whole lineup
    out.push(id);
  }
  return out;
}

export type AdvanceResult = {
  next: QueueState;
  /** the lineup restarted from the top — the strip must SAY so rather than
   *  silently snapping back to the first athlete */
  wrapped: boolean;
};

/** Called after a run is completed (and kept — a discarded run must not advance). */
export function advance(q: QueueState, active: ActiveSet): AdvanceResult {
  // A pending override is a one-off: consume it and resume exactly where the
  // lineup was. The cursor athlete still hasn't run, so the cursor stays put.
  if (q.overrideId) return { next: { ...q, overrideId: null }, wrapped: false };

  const order = activeOrder(q, active);
  if (order.length === 0) return { next: { ...q, cursorId: null }, wrapped: false };

  const anchor = cursorAnchorId(q, active);
  const i = anchor ? order.indexOf(anchor) : -1;
  const nextIdx = (i + 1) % order.length;
  // A lineup of one never "restarts" — flagging a wrap every single rep would
  // make the banner noise rather than information.
  const wrapped = order.length > 1 && nextIdx === 0;
  return { next: { ...q, cursorId: order[nextIdx] }, wrapped };
}

/**
 * Jump to any athlete (the picker behind the strip).
 * - already in the lineup → move the cursor there. No reordering.
 * - not in the lineup → a transient override; the cursor does not move, so the
 *   lineup resumes untouched after their run.
 */
export function jumpTo(q: QueueState, athleteId: string): QueueState {
  if (q.athleteIds.includes(athleteId)) {
    return { ...q, cursorId: athleteId, overrideId: null };
  }
  return { ...q, overrideId: athleteId };
}

/** Move a lineup entry (tap-to-pick / tap-to-place). cursorId and overrideId are
 *  IDs, so they keep pointing at the same PEOPLE — this is the whole reason
 *  reordering can't make someone run twice or get skipped. */
export function reorder(q: QueueState, from: number, to: number): QueueState {
  const ids = [...q.athleteIds];
  if (from < 0 || from >= ids.length || to < 0 || to >= ids.length || from === to) return q;
  const [moved] = ids.splice(from, 1);
  ids.splice(to, 0, moved);
  return { ...q, athleteIds: ids };
}

export function addToQueue(q: QueueState, athleteId: string): QueueState {
  if (q.athleteIds.includes(athleteId)) return q;
  const athleteIds = [...q.athleteIds, athleteId];
  return { ...q, athleteIds, cursorId: q.cursorId ?? athleteId };
}

/** Drop someone from the lineup. If they were up, the cursor takes their place
 *  in the order (the next athlete moves up) rather than resetting to the top. */
export function removeFromQueue(q: QueueState, athleteId: string): QueueState {
  const i = q.athleteIds.indexOf(athleteId);
  if (i < 0) return q;
  const athleteIds = q.athleteIds.filter((id) => id !== athleteId);
  let cursorId = q.cursorId;
  if (cursorId === athleteId) {
    cursorId = athleteIds.length ? athleteIds[Math.min(i, athleteIds.length - 1)] : null;
  }
  return {
    athleteIds,
    cursorId,
    overrideId: q.overrideId === athleteId ? null : q.overrideId,
  };
}

/** Load a template into today's queue. COPIES the ids — editing the day's
 *  lineup must never mutate the saved template. */
export function loadTemplate(athleteIds: string[]): QueueState {
  return { athleteIds: [...athleteIds], cursorId: athleteIds[0] ?? null, overrideId: null };
}
