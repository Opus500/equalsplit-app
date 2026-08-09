// Prove the unified drill picker's list and, above all, that the new optional
// `selectedKey` prop is a NO-OP when absent.
//
//   node scripts/verify-catalog.mjs
//
// L Drill and Shuttle Run are hardware-validated with no automated coverage, so
// "it behaves the same without the prop" is the one claim that must not be taken
// on trust. The selection rule is pure and lives in src/ble/catalog.ts precisely
// so it can be checked here instead of assumed.

import './_ts-resolve.mjs';

const { DRILL_CATALOG, entryFor, kindFor, resolveKey } = await import('../src/ble/catalog.ts');
const { DRILLS } = await import('../src/ble/drills.ts');
const { REPEATS } = await import('../src/ble/repeats.ts');

let failures = 0;
const check = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n         got  ${g}\n         want ${w}`}`);
};

console.log('\n1. THE CONDITION: no selectedKey => the screen keeps its own state');
{
  // This is the whole safety argument for touching DrillsScreen at all. With no
  // prop, the resolved key is the internal one, unchanged, every time.
  check('undefined falls back', resolveKey(undefined, 'l-drill'), 'l-drill');
  check('null falls back', resolveKey(null, 'l-drill'), 'l-drill');
  check('and for the other drill too', resolveKey(undefined, 'shuttle'), 'shuttle');

  // Exhaustive over every key the screen could hold internally.
  const bad = DRILLS.filter((d) => resolveKey(undefined, d.key) !== d.key);
  check('every counted drill is unaffected by an absent prop', bad, []);

  // And a provided key does take over.
  check('a provided key wins', resolveKey('shuttle', 'l-drill'), 'shuttle');
  check('even when it matches', resolveKey('l-drill', 'l-drill'), 'l-drill');

  // Empty string is a real value, not "absent" — it must NOT silently fall back,
  // or a bug upstream would look like correct default behaviour.
  check('empty string is not treated as absent', resolveKey('', 'l-drill'), '');
}

console.log('\n2. the catalog is DERIVED, so a new drill needs no second edit');
{
  check(
    'one entry per engine config, nothing else',
    DRILL_CATALOG.length,
    DRILLS.length + REPEATS.length,
  );
  check(
    'every counted drill is listed',
    DRILLS.every((d) => entryFor(d.key)?.kind === 'counted'),
    true,
  );
  check(
    'every rep variant is listed',
    REPEATS.every((r) => entryFor(r.key)?.kind === 'repeat'),
    true,
  );
  check('keys are unique', new Set(DRILL_CATALOG.map((e) => e.key)).size, DRILL_CATALOG.length);
  check('every entry has a title', DRILL_CATALOG.every((e) => e.title.length > 0), true);
  check('every entry has a blurb', DRILL_CATALOG.every((e) => e.blurb.length > 0), true);
}

console.log('\n3. kind routes to the right screen');
{
  check('l-drill -> counted', kindFor('l-drill'), 'counted');
  check('shuttle -> counted', kindFor('shuttle'), 'counted');
  check('repeat-continuous -> repeat', kindFor('repeat-continuous'), 'repeat');
  check('repeat-rest -> repeat', kindFor('repeat-rest'), 'repeat');
  check('an unknown key routes nowhere', kindFor('nope'), null);
  check('and resolves to no entry', entryFor('nope'), null);

  // Counted first: the picker opens on what is used most.
  check('counted drills lead the list', DRILL_CATALOG[0].kind, 'counted');
  const firstRepeat = DRILL_CATALOG.findIndex((e) => e.kind === 'repeat');
  const lastCounted = DRILL_CATALOG.map((e) => e.kind).lastIndexOf('counted');
  check('and the two kinds are not interleaved', lastCounted < firstRepeat, true);
}

console.log('\n=============================');
console.log(failures === 0 ? 'RESULT: OK — catalog and the no-op default hold.' : `RESULT: ${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
