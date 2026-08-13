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

// LOCALE-INDEPENDENT from here on. These assertions used to hardcode
// 'added Jan 5' and 'added Jul 30', which is an en-* rendering — the code calls
// toLocaleDateString(undefined, …) and takes the machine's locale, so the test
// passed on the author's laptop and failed on anyone else's. A test that only
// holds in one environment is not a test of the code.
//
// The date is rendered here through the SAME options the code uses, so the
// month/day shape is still pinned; what is no longer pinned is the language. The
// part that actually matters — that each athlete gets THEIR OWN date and the two
// differ — is asserted directly.
const JAN = localMs(2026, 0, 5);
const JUL = localMs(2026, 6, 30);
const added = (ms) =>
  `added ${new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;

console.log('\n3. no group given -> added-date fallback');
{
  const d = detailsOf([A('a1', 'Jayden', null, JAN), A('a2', 'Jayden', null, JUL)]);
  check('dates distinguish', d, { a1: added(JAN), a2: added(JUL) });
  check('each carries its own date, not the same one twice', d.a1 !== d.a2, true);
  check('and both are date fallbacks, not group names', [d.a1, d.a2].every((s) => s.startsWith('added ')), true);
  console.log(`       (this environment renders them "${d.a1}" and "${d.a2}")`);
}

console.log('\n4. last resort: same group, or added the same day');
check(
  'id suffix appended only when still colliding',
  detailsOf([A('a1x9f2', 'Jayden', 'Varsity'), A('a2b4e7', 'Jayden', 'Varsity')]),
  { a1x9f2: 'Varsity · #x9f2', a2b4e7: 'Varsity · #b4e7' },
);
{
  // Same day AND no groups, so the date collides too and only the id can separate
  // them. The id suffix is the assertion; the date is whatever the locale says.
  const d = detailsOf([A('id001122', 'Jayden'), A('id003344', 'Jayden')]);
  check('same day, no groups', d, {
    id001122: `${added(JUL)} · #1122`,
    id003344: `${added(JUL)} · #3344`,
  });
  check('the id is what breaks the tie', [d.id001122.endsWith('#1122'), d.id003344.endsWith('#3344')], [true, true]);
}

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
