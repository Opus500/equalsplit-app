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
  q = jumpTo(q, 'D', active());
  check('cursor moved to D', currentAthleteId(q, active()), 'D');
  check('lineup order untouched', q.athleteIds, ALL);
  check('nobody was inserted', q.athleteIds.length, ALL.length);
  check('next wraps from D', upNext(q, active(), 2), ['A', 'B']);
}

console.log('\n4. jump to someone NOT in the lineup INSERTS them at the cursor');
{
  let q = loadTemplate(ALL);
  q = advance(q, active()).next; // cursor -> B
  const act = active([...ALL, 'Z']);
  q = jumpTo(q, 'Z', act); // a walk-up athlete, not in today's lineup

  check('Z is inserted where B was', q.athleteIds, ['A', 'Z', 'B', 'C', 'D']);
  check('Z is up', currentAthleteId(q, act), 'Z');
  check('B — who WAS up — runs next, losing no turn', upNext(q, act, 2), ['B', 'C']);

  const r = advance(q, act); // Z finishes
  q = r.next;
  check('the lineup resumes at B', currentAthleteId(q, act), 'B');
  check('no false wrap', r.wrapped, false);

  // The whole point of the change: Z is still in rotation next time round.
  q = advance(q, act).next; // C
  q = advance(q, act).next; // D
  const wrap = advance(q, act); // -> A
  check('wrap announced', wrap.wrapped, true);
  check('and Z comes round again', upNext(wrap.next, act, 1), ['Z']);
  console.log('       (under the old override, Z ran once and was never seen again)');
}

console.log('\n4b. the insert never costs the athlete who was up their turn');
{
  // Exhaustive over cursor position: whoever was up must end up exactly next.
  let bad = 0;
  for (let start = 0; start < ALL.length; start++) {
    let q = loadTemplate(ALL);
    for (let k = 0; k < start; k++) q = advance(q, active()).next;
    const act = active([...ALL, 'Z']);
    const was = currentAthleteId(q, act);
    const j = jumpTo(q, 'Z', act);
    if (currentAthleteId(j, act) !== 'Z') bad++;
    if (upNext(j, act, 1)[0] !== was) bad++;
    if (j.athleteIds.length !== ALL.length + 1) bad++;
    if (new Set(j.athleteIds).size !== ALL.length + 1) bad++;
  }
  check('all 4 cursor positions insert correctly', bad, 0);

  // Jumping to someone ALREADY in the lineup must not duplicate them.
  const dup = jumpTo(loadTemplate(ALL), 'C', active());
  check('an in-lineup jump adds nobody', dup.athleteIds, ALL);

  // Degenerate: an empty lineup gains its first athlete.
  const fresh = jumpTo(EMPTY_QUEUE, 'Z', active(['Z']));
  check('empty lineup accepts the insert', fresh.athleteIds, ['Z']);
  check('and they are up', currentAthleteId(fresh, active(['Z'])), 'Z');
}

console.log('\n4c. the insert is SESSION-only — a saved template is never touched');
{
  const template = ['A', 'B', 'C'];
  let q = loadTemplate(template);
  const act = active([...template, 'Z']);
  q = jumpTo(q, 'Z', act);
  check('template array untouched', template, ['A', 'B', 'C']);
  check("today's lineup gained Z", q.athleteIds, ['Z', 'A', 'B', 'C']);
  console.log('       (loadTemplate COPIES the ids, so the live queue cannot alias a template)');
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

console.log('\n7c. skipping an inserted walk-up hands over to whoever was up');
{
  let q = loadTemplate(ALL);
  q = advance(q, active()).next; // cursor -> B
  const act = active([...ALL, 'Z']);
  q = jumpTo(q, 'Z', act);
  check('Z is up', currentAthleteId(q, act), 'Z');
  const r = advance(q, act); // skip Z without running
  check('B takes over', currentAthleteId(r.next, act), 'B');
  check('Z stays in the lineup — a skip is not a removal', r.next.athleteIds, [
    'A',
    'Z',
    'B',
    'C',
    'D',
  ]);
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
  // SPELT OUT, not compared against the state it was cloned from. This read
  // `upNext(snapshot, …)` against `upNext(q, …)` where snapshot IS a deep clone of
  // q — an assertion that holds for any implementation of upNext that is not
  // actively random, and so proved nothing about undo at all. From D, up-next
  // wraps: A then B.
  check('undo restores up-next', upNext(snapshot, active(), 2), ['A', 'B']);
  check('undo restores the lineup', snapshot.athleteIds, ALL);
  // `wrapped` is DERIVED, never stored — so there is nothing to un-derive; the
  // UI only has to retract the announcement.
  check('re-advancing from the restored state wraps identically', advance(snapshot, active()).wrapped, true);
}

console.log('\n7e. UNDO of a skipped walk-up puts them back up');
{
  let q = loadTemplate(ALL);
  q = advance(q, active()).next; // cursor -> B
  const act = active([...ALL, 'Z']);
  q = jumpTo(q, 'Z', act);
  const snapshot = JSON.parse(JSON.stringify(q));
  const skipped = advance(q, act); // skip Z
  check('after skipping, B is up', currentAthleteId(skipped.next, act), 'B');
  check('undo puts Z back up', currentAthleteId(snapshot, act), 'Z');
  check('and the insert survives the undo', snapshot.athleteIds, ['A', 'Z', 'B', 'C', 'D']);
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
