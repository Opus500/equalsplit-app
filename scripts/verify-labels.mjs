// Prove duplicate-name disambiguation: two athletes sharing a name must be
// distinguishable in every list.  node scripts/verify-labels.mjs
import './_ts-resolve.mjs'; // must be linked before labels.ts is loaded
const { disambiguate, runCountLabel } = await import('../src/roster/labels.ts');

let failures = 0;
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`);
};
// LOCAL dates, not Date.UTC: the label renders with toLocaleDateString, and the
// app deliberately files runs by local calendar day (see localDayString) so an
// evening session doesn't show up as tomorrow.
const localMs = (y, m, d) => new Date(y, m, d, 12, 0, 0).getTime();
const A = (id, display_name, group_name = null, created_at = localMs(2026, 6, 30)) => ({
  id,
  display_name,
  group_name,
  created_at,
});
const detailsOf = (list) => Object.fromEntries(disambiguate(list));

console.log('\n1. unique names carry no clutter');
check('no detail lines', detailsOf([A('a1', 'Jayden'), A('a2', 'Mia')]), { a1: null, a2: null });

console.log("\n2. duplicates use the coach's own words (group_name)");
check(
  'group names distinguish',
  detailsOf([A('a1', 'Jayden', 'Varsity'), A('a2', 'Jayden', 'JV')]),
  { a1: 'Varsity', a2: 'JV' },
);

console.log('\n3. no group given -> added-date fallback');
check(
  'dates distinguish',
  detailsOf([
    A('a1', 'Jayden', null, localMs(2026, 0, 5)),
    A('a2', 'Jayden', null, localMs(2026, 6, 30)),
  ]),
  { a1: 'added Jan 5', a2: 'added Jul 30' },
);

console.log('\n4. last resort: same group, or added the same day');
check(
  'id suffix appended only when still colliding',
  detailsOf([A('a1x9f2', 'Jayden', 'Varsity'), A('a2b4e7', 'Jayden', 'Varsity')]),
  { a1x9f2: 'Varsity · #x9f2', a2b4e7: 'Varsity · #b4e7' },
);
check(
  'same day, no groups',
  detailsOf([A('id001122', 'Jayden'), A('id003344', 'Jayden')]),
  { id001122: 'added Jul 30 · #1122', id003344: 'added Jul 30 · #3344' },
);

console.log('\n5. case/accent variants count as the SAME name for ambiguity');
check(
  'folded duplicates are disambiguated',
  detailsOf([A('a1', 'jayden', 'Varsity'), A('a2', 'JAYDEN', 'JV')]),
  { a1: 'Varsity', a2: 'JV' },
);

console.log('\n6. mixed list: only the ambiguous ones get a detail');
check(
  'Mia stays clean',
  detailsOf([A('a1', 'Jayden', 'Varsity'), A('a2', 'Jayden', 'JV'), A('a3', 'Mia')]),
  { a1: 'Varsity', a2: 'JV', a3: null },
);

console.log('\n7. ambiguity is scoped to the list actually rendered');
{
  const all = [A('a1', 'Jayden', 'Varsity'), A('a2', 'Jayden', 'JV')];
  check('hiding the archived twin removes the clutter', detailsOf([all[0]]), { a1: null });
}

console.log('\n8. zero-run athletes read naturally (6 were seeded from recents)');
check('zero', runCountLabel(0), 'no runs yet');
check('one', runCountLabel(1), '1 run');
check('many', runCountLabel(12), '12 runs');

console.log('\n=============================');
console.log(failures === 0 ? 'RESULT: OK — disambiguation holds.' : `RESULT: ${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
