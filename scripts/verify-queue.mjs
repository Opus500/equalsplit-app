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
