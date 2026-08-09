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
};

export const EMPTY_QUEUE: QueueState = { athleteIds: [], cursorId: null };

/** Ids currently selectable — i.e. not archived. Archived athletes stay IN the
 *  lineup array (removing them would silently edit the coach's lineup) but are
 *  skipped when choosing who is up. */
export type ActiveSet = ReadonlySet<string>;

function activeOrder(q: QueueState, active: ActiveSet): string[] {
  return q.athleteIds.filter((id) => active.has(id));
}

/** Falls back to the top when the cursor's athlete has left the lineup or been
 *  archived, so an archived athlete can never strand the queue. */
function cursorAnchorId(q: QueueState, active: ActiveSet): string | null {
  const order = activeOrder(q, active);
  if (order.length === 0) return null;
  if (q.cursorId && order.includes(q.cursorId)) return q.cursorId;
  return order[0];
}

/** Who is up right now. */
export function currentAthleteId(q: QueueState, active: ActiveSet): string | null {
  return cursorAnchorId(q, active);
}

/** The next `count` athletes for the "up next" strip. */
export function upNext(q: QueueState, active: ActiveSet, count = 2): string[] {
  const order = activeOrder(q, active);
  if (order.length === 0) return [];
  const anchor = cursorAnchorId(q, active);
  if (!anchor) return [];
  const i = order.indexOf(anchor);
  const out: string[] = [];
  for (let k = 0; out.length < count && k < order.length; k++) {
    const id = order[(i + 1 + k) % order.length];
    if (id === anchor) continue; // never list whoever is currently up
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
 *
 * - already in the lineup → move the cursor there. No reordering.
 * - NOT in the lineup → INSERT them at the current cursor position and make them
 *   up. Whoever was up runs next, so nobody loses a turn, and the walk-up stays
 *   in the rotation for the rest of the session.
 *
 * This replaced a transient one-off override. The override read as correct in the
 * moment and wrong afterwards: the athlete ran once and never came round again,
 * so a coach who pulled someone in mid-session had to notice and re-add them.
 * Inserting is the behaviour that matches what "they're running now" means.
 *
 * Session-only by construction: this edits the live QueueState, and loadTemplate
 * COPIES a template's ids in, so a saved template can never be reached from here.
 */
export function jumpTo(q: QueueState, athleteId: string, active: ActiveSet): QueueState {
  if (q.athleteIds.includes(athleteId)) {
    return { ...q, cursorId: athleteId };
  }
  // Insert immediately BEFORE whoever is up, so they become next rather than
  // being skipped. Uses the effective current athlete (not the raw cursorId), so
  // an archived cursor can't drop the insert in the wrong place.
  const upNow = currentAthleteId(q, active);
  const at = upNow ? q.athleteIds.indexOf(upNow) : -1;
  const athleteIds = [...q.athleteIds];
  athleteIds.splice(at < 0 ? athleteIds.length : at, 0, athleteId);
  return { athleteIds, cursorId: athleteId };
}

/** Move a lineup entry (tap-to-pick / tap-to-place). cursorId is an ID, so it
 *  keeps pointing at the same PERSON — this is the whole reason reordering can't
 *  make someone run twice or get skipped. */
export function reorder(q: QueueState, from: number, to: number): QueueState {
  const ids = [...q.athleteIds];
  if (from < 0 || from >= ids.length || to < 0 || to >= ids.length || from === to) return q;
  const [moved] = ids.splice(from, 1);
  ids.splice(to, 0, moved);
  return { ...q, athleteIds: ids };
}

/**
 * Tap-to-place: turn a chosen SLOT into the destination index for reorder().
 *
 * With n athletes there are n+1 slots — the gaps above each row plus one at the
 * end — so slot indices and item indices are not the same space. reorder() splices
 * the item OUT before putting it back, which shifts every slot after `from` down
 * by one; without this correction, dragging downwards lands one place short.
 *
 * Slots `from` and `from+1` are both "where it already is" and map to a no-op.
 */
export function slotToIndex(from: number, slot: number): number {
  return slot > from ? slot - 1 : slot;
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
  return { athleteIds, cursorId };
}

/** Load a template into today's queue. COPIES the ids — editing the day's
 *  lineup must never mutate the saved template. */
export function loadTemplate(athleteIds: string[]): QueueState {
  return { athleteIds: [...athleteIds], cursorId: athleteIds[0] ?? null };
}
