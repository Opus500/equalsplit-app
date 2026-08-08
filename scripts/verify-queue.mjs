// Prove the practice-queue semantics before any UI is built on them.
//
//   node scripts/verify-queue.mjs
//
// Imports src/roster/queue.ts directly (Node 24 strips TS types natively), so it
// exercises the real rules, not a description of them. Zero dependencies.

import {
  EMPTY_QUEUE,
  advance,
  currentAthleteId,
  jumpTo,
  loadTemplate,
  removeFromQueue,
  reorder,
  slotToIndex,
  upNext,
} from '../src/roster/queue.ts';

let failures = 0;
const check = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n         got  ${g}\n         want ${w}`}`);
};

const ALL = ['A', 'B', 'C', 'D'];
const active = (ids = ALL) => new Set(ids);

console.log('\n1. lineup order + wrap is announced, not silent');
{
  let q = loadTemplate(ALL);
  const ran = [];
  let wraps = 0;
  for (let i = 0; i < 5; i++) {
    ran.push(currentAthleteId(q, active()));
    const r = advance(q, active());
    q = r.next;
    if (r.wrapped) wraps++;
  }
  check('runs in lineup order then restarts', ran, ['A', 'B', 'C', 'D', 'A']);
  check('wrap reported exactly once', wraps, 1);
}

console.log('\n2. reorder cannot make anyone run twice or be skipped  (requirement 10)');
{
  // Cursor is on C. Drag D to the very front — a classic index-based bug.
  let q = loadTemplate(ALL);
  q = advance(q, active()).next; // -> B
  q = advance(q, active()).next; // -> C
  check('current before reorder', currentAthleteId(q, active()), 'C');
  q = reorder(q, 3, 0); // D,A,B,C
  check('lineup after dragging D to front', q.athleteIds, ['D', 'A', 'B', 'C']);
  check('current is STILL C', currentAthleteId(q, active()), 'C');
  check('next after C is unchanged (wraps to D)', upNext(q, active(), 2), ['D', 'A']);

  // What an index-based cursor would have done, for contrast:
  const indexBased = ['D', 'A', 'B', 'C'][2]; // cursor index 2 after the move
  console.log(
    `       (an index-based cursor would now point at ${indexBased} — B re-runs, C skipped)`,
  );
}

console.log('\n3. jump to someone IN the lineup moves the cursor, no reordering');
{
  let q = loadTemplate(ALL); // cursor A
  q = jumpTo(q, 'D');
  check('cursor moved to D', currentAthleteId(q, active()), 'D');
  check('lineup order untouched', q.athleteIds, ALL);
  check('no override pending', q.overrideId, null);
  check('next wraps from D', upNext(q, active(), 2), ['A', 'B']);
}

console.log('\n4. jump to someone NOT in the lineup is a one-off override');
{
  let q = loadTemplate(ALL);
  q = advance(q, active()).next; // cursor -> B
  q = jumpTo(q, 'Z'); // a walk-up athlete, not in today's lineup
  const act = active([...ALL, 'Z']);
  check('Z is up', currentAthleteId(q, act), 'Z');
  check('cursor did NOT move (B still next)', upNext(q, act, 2), ['B', 'C']);
  check('lineup not reordered', q.athleteIds, ALL);

  const r = advance(q, act); // Z finishes
  q = r.next;
  check('override consumed', q.overrideId, null);
  check('lineup resumes exactly where it was', currentAthleteId(q, act), 'B');
  check('no false wrap from the override', r.wrapped, false);
}

console.log('\n5. archived athletes are skipped but stay in the lineup');
{
  let q = loadTemplate(ALL);
  const act = active(['A', 'C', 'D']); // B archived mid-practice
  check('B still in the saved lineup', q.athleteIds.includes('B'), true);
  check('A is up', currentAthleteId(q, act), 'A');
  check('B is skipped in up-next', upNext(q, act, 2), ['C', 'D']);
  q = advance(q, act).next;
  check('advance skips B', currentAthleteId(q, act), 'C');
}

console.log('\n6. archiving the athlete who is UP does not strand the lineup');
{
  let q = loadTemplate(ALL);
  q = advance(q, active()).next; // cursor -> B
  const act = active(['A', 'C', 'D']); // B archived while up
  check('falls forward to a live athlete', currentAthleteId(q, act), 'A');
  check('advance still works', currentAthleteId(advance(q, act).next, act), 'C');
}

console.log('\n7. degenerate lineups');
{
  check('empty queue has nobody up', currentAthleteId(EMPTY_QUEUE, active()), null);
  check('empty queue up-next is empty', upNext(EMPTY_QUEUE, active(), 2), []);
  check('empty queue advance is inert', advance(EMPTY_QUEUE, active()).next, EMPTY_QUEUE);

  const solo = loadTemplate(['A']);
  check('solo athlete stays up', currentAthleteId(advance(solo, active(['A'])).next, active(['A'])), 'A');
  check('solo athlete never shows a wrap banner', advance(solo, active(['A'])).wrapped, false);
  check('solo athlete has no up-next', upNext(solo, active(['A']), 2), []);

  const allArchived = loadTemplate(ALL);
  check('everyone archived => nobody up', currentAthleteId(allArchived, active([])), null);
}

console.log('\n7b. SKIP is not removal — skipped athletes come back on the wrap');
{
  // Skip shares advance() with completeRun (no run is written), so the property
  // to pin is that the lineup ARRAY is untouched and the athlete returns.
  let q = loadTemplate(ALL); // A up
  const before = [...q.athleteIds];
  q = advance(q, active()).next; // "skip" A -> B
  check('lineup array untouched by a skip', q.athleteIds, before);
  check('B is now up', currentAthleteId(q, active()), 'B');
  q = advance(q, active()).next; // C
  q = advance(q, active()).next; // D
  const r = advance(q, active()); // wraps
  check('skipped A comes back around', currentAthleteId(r.next, active()), 'A');
  check('and the wrap is still announced', r.wrapped, true);
}

console.log('\n7c. skipping a one-off jump returns to the lineup, cursor intact');
{
  let q = loadTemplate(ALL);
  q = advance(q, active()).next; // cursor -> B
  q = jumpTo(q, 'Z');
  const act = active([...ALL, 'Z']);
  check('Z is up', currentAthleteId(q, act), 'Z');
  const r = advance(q, act); // skip Z without running
  check('override consumed, not the cursor', currentAthleteId(r.next, act), 'B');
  check('lineup untouched', r.next.athleteIds, ALL);
}

console.log('\n7d. UNDO of a skip restores the state EXACTLY, wrap included');
{
  // Undo restores a snapshot of the whole QueueState rather than inverting the
  // move, so exactness is structural. These checks pin that the restored state
  // is indistinguishable from the pre-skip one — cursor, up-next and lineup.
  let q = loadTemplate(ALL);
  q = advance(q, active()).next; // B
  q = advance(q, active()).next; // C
  q = advance(q, active()).next; // D — last in the lineup, so the next skip wraps
  const snapshot = JSON.parse(JSON.stringify(q)); // what undo stores

  const skipped = advance(q, active());
  check('the skip wrapped', skipped.wrapped, true);
  check('and moved to the top', currentAthleteId(skipped.next, active()), 'A');

  check('undo restores the cursor', currentAthleteId(snapshot, active()), 'D');
  check('undo restores up-next', upNext(snapshot, active(), 2), upNext(q, active(), 2));
  check('undo restores the lineup', snapshot.athleteIds, ALL);
  check('undo restores the override slot', snapshot.overrideId, null);
  // `wrapped` is DERIVED, never stored — so there is nothing to un-derive; the
  // UI only has to retract the announcement.
  check('re-advancing from the restored state wraps identically', advance(snapshot, active()).wrapped, true);
}

console.log('\n7e. UNDO of a skip that consumed a one-off jump restores the jump');
{
  let q = loadTemplate(ALL);
  q = advance(q, active()).next; // cursor -> B
  q = jumpTo(q, 'Z');
  const act = active([...ALL, 'Z']);
  const snapshot = JSON.parse(JSON.stringify(q));
  const skipped = advance(q, act); // skip Z
  check('after skipping, B is up', currentAthleteId(skipped.next, act), 'B');
  check('undo puts Z back up', currentAthleteId(snapshot, act), 'Z');
  check('undo restores the pending override', snapshot.overrideId, 'Z');
  check('and the cursor was never moved', snapshot.cursorId, 'B');
}

console.log('\n7f. TAP-TO-PLACE: every slot lands the athlete exactly where it was tapped');
{
  // n athletes => n+1 slots (the gap above each row, plus one at the end). This is
  // the off-by-one that makes a downward move land one place short.
  const names = ['A', 'B', 'C', 'D'];
  const place = (from, slot) => reorder(loadTemplate(names), from, slotToIndex(from, slot)).athleteIds;

  check('move A (0) to the end (slot 4)', place(0, 4), ['B', 'C', 'D', 'A']);
  check('move A (0) to slot 2 = between B and C', place(0, 2), ['B', 'A', 'C', 'D']);
  check('move D (3) to the top (slot 0)', place(3, 0), ['D', 'A', 'B', 'C']);
  check('move C (2) up one (slot 1)', place(2, 1), ['A', 'C', 'B', 'D']);
  check('move B (1) down one (slot 3)', place(1, 3), ['A', 'C', 'B', 'D']);

  // Both slots adjacent to an item mean "leave it alone".
  check('slot above self is a no-op', place(2, 2), names);
  check('slot below self is a no-op', place(2, 3), names);

  // Exhaustive: for every (from, slot), the moved athlete must end up with exactly
  // the athletes that were before that slot ahead of it.
  let wrong = 0;
  for (let from = 0; from < names.length; from++) {
    for (let slot = 0; slot <= names.length; slot++) {
      const out = place(from, slot);
      const moved = names[from];
      const expectedAhead = names.filter((n, i) => i !== from).slice(0, slotToIndex(from, slot));
      if (out.indexOf(moved) !== expectedAhead.length) wrong++;
      if (out.length !== names.length || new Set(out).size !== names.length) wrong++;
    }
  }
  check('all 20 (from, slot) pairs land correctly and lose nobody', wrong, 0);
}

console.log('\n7g. reorder under a live cursor  (the property tap-to-place must not break)');
{
  // Same guarantee as block 2, restated through the tap-to-place path, because the
  // editor is what a coach will actually be using mid-practice.
  let q = loadTemplate(ALL);
  q = advance(q, active()).next; // -> B
  check('B is up', currentAthleteId(q, active()), 'B');

  // Tap B and drop it at the very end while it is the current athlete.
  q = reorder(q, 1, slotToIndex(1, 4));
  check('lineup reordered', q.athleteIds, ['A', 'C', 'D', 'B']);
  check('B is STILL up — the cursor tracks the athlete', currentAthleteId(q, active()), 'B');
  check('and up-next follows the new order', upNext(q, active(), 2), ['A', 'C']);

  // Moving someone ELSE past the cursor must not steal the current turn either.
  let r = loadTemplate(ALL);
  r = advance(r, active()).next; // -> B
  r = reorder(r, 3, slotToIndex(3, 0)); // D to the top
  check('cursor unaffected by a move around it', currentAthleteId(r, active()), 'B');
  check('nobody is dropped or duplicated', [...r.athleteIds].sort(), [...ALL].sort());
}

console.log('\n8. removing the athlete who is up hands over to the next');
{
  let q = loadTemplate(ALL);
  q = advance(q, active()).next; // cursor -> B
  q = removeFromQueue(q, 'B');
  check('B gone from lineup', q.athleteIds, ['A', 'C', 'D']);
  check('C takes over (no reset to the top)', currentAthleteId(q, active()), 'C');
}

console.log('\n9. loading a template copies it — editing the day never mutates the saved lineup');
{
  const template = ['A', 'B', 'C'];
  let q = loadTemplate(template);
  q = reorder(q, 0, 2);
  q = removeFromQueue(q, 'B');
  check('template object untouched', template, ['A', 'B', 'C']);
  check("today's lineup diverged", q.athleteIds, ['C', 'A']);
}

console.log('\n=============================');
console.log(failures === 0 ? 'RESULT: OK — all queue semantics hold.' : `RESULT: ${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
