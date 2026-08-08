// Prove exactly what the test-data prune would and would not delete.
//
//   node scripts/verify-prune.mjs
//
// Imports src/runs/prune.ts directly. Zero dependencies.

import {
  bucketRuns,
  cutoffForBucket,
  isPrunable,
  summarize,
} from '../src/runs/prune.ts';

let failures = 0;
const check = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n         got  ${g}\n         want ${w}`}`);
};
const truthy = (label, got) => check(label, !!got, true);

// Local-time dates, matching how the buckets are computed.
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();
let seq = 0;
const run = (createdAt, athleteId, drillId = null) => ({
  id: `r${++seq}`,
  createdAt,
  athleteId,
  drillId,
});

console.log('\n1. THE QUESTION: does it catch a run with a DRILL but no athlete?');
{
  const withDrill = run(at(2026, 5, 1), null, 'd30');
  const bare = run(at(2026, 5, 1), null, null);
  const cutoff = at(2026, 6, 1);
  check('drill + no athlete IS caught', isPrunable(withDrill, cutoff), true);
  check('no drill + no athlete IS caught', isPrunable(bare, cutoff), true);
  console.log('       (the predicate names athlete_id and the date only — drill is not in it)');
}

console.log('\n2. what it never touches');
{
  const cutoff = at(2026, 6, 1);
  check(
    'an ATTRIBUTED run is spared however old',
    isPrunable(run(at(2020, 1, 1), 'a1', 'd30'), cutoff),
    false,
  );
  check(
    'an attributed run with NO drill is spared too',
    isPrunable(run(at(2020, 1, 1), 'a1', null), cutoff),
    false,
  );
  check(
    'an unassigned run NEWER than the cutoff is spared',
    isPrunable(run(at(2026, 7, 1), null, null), cutoff),
    false,
  );
  console.log('       (so a future standalone B1 run — unassigned by design — is never eligible)');
}

console.log('\n3. the cutoff boundary is exclusive, to the millisecond');
{
  const cutoff = at(2026, 6, 1);
  check('one ms before the cutoff is caught', isPrunable(run(cutoff - 1, null), cutoff), true);
  check('exactly ON the cutoff is spared', isPrunable(run(cutoff, null), cutoff), false);
  check('after the cutoff is spared', isPrunable(run(cutoff + 1, null), cutoff), false);
}

console.log('\n4. the summary accounts for every run, with no double counting');
{
  const runs = [
    run(at(2026, 5, 1), null, 'd30'), // matched, with drill
    run(at(2026, 5, 2), null, null), // matched, no drill
    run(at(2026, 5, 3), 'a1', 'd30'), // attributed (old, but kept)
    run(at(2026, 7, 1), null, null), // unassigned but too new
    run(at(2026, 7, 2), 'a2', null), // attributed
  ];
  const s = summarize(runs, at(2026, 6, 1));
  check('matched', s.matched, 2);
  check('of which carried a drill', s.matchedWithDrill, 1);
  check('spared (unassigned, too new)', s.spared, 1);
  check('attributed', s.attributed, 2);
  check('every run is in exactly one bucket', s.matched + s.spared + s.attributed, s.total);
}

console.log('\n5. buckets show WHERE the test data is, not just how much');
{
  // Two dense unassigned weeks (test data), then a real session with attribution.
  const runs = [];
  for (let i = 0; i < 40; i++) runs.push(run(at(2026, 5, 4 + (i % 5)), null, 'd30'));
  for (let i = 0; i < 12; i++) runs.push(run(at(2026, 5, 11 + (i % 5)), null, null));
  for (let i = 0; i < 8; i++) runs.push(run(at(2026, 7, 6 + (i % 3)), `a${i % 3}`, 'd30'));
  runs.push(run(at(2026, 7, 7), null, 'd30')); // one stray untagged in a real week

  const weeks = bucketRuns(runs, 'week');
  check('newest week first', weeks[0].start > weeks[1].start, true);
  const real = weeks[0];
  check('the real week is mostly attributed', [real.total, real.unassigned], [9, 1]);
  const testWeeks = weeks.filter((w) => w.unassigned === w.total);
  check('two all-unassigned weeks stand out', testWeeks.length, 2);
  check('and they hold the bulk', testWeeks.reduce((n, w) => n + w.total, 0), 52);
  console.log(
    `       (${weeks.map((w) => `${w.label}: ${w.unassigned}/${w.total}`).join('  |  ')})`,
  );
}

console.log('\n6. picking a bucket means "everything up to and including it"');
{
  const runs = [
    run(at(2026, 5, 6), null), // in the chosen week
    run(at(2026, 5, 20), null), // a later week
  ];
  const weeks = bucketRuns(runs, 'week');
  const older = weeks[weeks.length - 1]; // oldest
  const cutoff = cutoffForBucket(older);
  check('the run inside the chosen week is caught', isPrunable(runs[0], cutoff), true);
  check('a run in a later week is not', isPrunable(runs[1], cutoff), false);
  truthy('the cutoff is the end of that period', cutoff === older.end);
}

console.log('\n7. week bucketing is Monday-based and does not split a week at Sunday');
{
  // Sun 3 May 2026 and Mon 4 May 2026 must land in DIFFERENT weeks;
  // Mon 4 May and Sun 10 May must land in the SAME one.
  const sun = run(at(2026, 5, 3), null);
  const mon = run(at(2026, 5, 4), null);
  const nextSun = run(at(2026, 5, 10), null);
  const weeks = bucketRuns([sun, mon, nextSun], 'week');
  check('three runs across two weeks', weeks.length, 2);
  const monWeek = weeks.find((w) => w.start <= mon.createdAt && mon.createdAt < w.end);
  check('Mon and the following Sun share a week', monWeek.total, 2);
  check('the earlier Sunday is its own week', weeks.find((w) => w !== monWeek).total, 1);
}

console.log('\n8. month bucketing');
{
  const runs = [
    run(at(2026, 5, 31, 23), null),
    run(at(2026, 6, 1, 0), null),
    run(at(2026, 6, 30), null),
  ];
  const months = bucketRuns(runs, 'month');
  check('two months', months.length, 2);
  check('newest first, with 2 in June', months[0].total, 2);
  check('and 1 in May', months[1].total, 1);
}

console.log('\n9. degenerate inputs');
{
  check('no runs => no buckets', bucketRuns([], 'week'), []);
  check('no runs => empty summary', summarize([], Date.now()).total, 0);
  check('a bad timestamp is skipped, not bucketed as 1970', bucketRuns([run(NaN, null)], 'week'), []);
  const allAttributed = [run(at(2026, 5, 1), 'a1'), run(at(2026, 5, 2), 'a2')];
  check('nothing to prune when everything is attributed', summarize(allAttributed, at(2027, 1, 1)).matched, 0);
  check('but the buckets still render for context', bucketRuns(allAttributed, 'week').length, 1);
  check('showing 0 prunable', bucketRuns(allAttributed, 'week')[0].unassigned, 0);
}

console.log('\n=============================');
console.log(failures === 0 ? 'RESULT: OK — prune predicate and bucketing hold.' : `RESULT: ${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
