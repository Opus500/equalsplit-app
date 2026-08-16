// Prove the colour vocabulary before a hue can mean two things again.
//
//   node scripts/verify-theme.mjs
//
// This is the guard, not src/theme.ts. Naming the roles is only half the fix — the
// palette rotted in the first place because every choice was locally reasonable and
// nobody checked what the colour already meant, and a file of named constants does
// not stop the next person writing '#fbbf24' inline.
//
// So there are three rules, and all three are about DRIFT rather than taste:
//
//   1. No semantic hex appears as a literal outside theme.ts.
//   2. No two roles share a value — that is the original bug, stated directly.
//   3. Roles are far enough apart in hue to be told apart on the app's ground.
//
// Zero dependencies. Reads the source as text, which is the point: it is checking
// what someone can type, not what the app happens to render.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(HERE, '..', 'src');
const THEME = join(SRC, 'theme.ts');

let failures = 0;
const check = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n         got  ${g}\n         want ${w}`}`);
};
const truthy = (label, v) => check(label, !!v, true);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

const themeSrc = readFileSync(THEME, 'utf8');
const files = walk(SRC).filter((p) => p !== THEME);

// ---------------------------------------------------------------- the roles

/** Everything exported as a bare hex, by name. */
const roles = {};
for (const m of themeSrc.matchAll(/export const ([A-Z_0-9]+) = '(#[0-9a-fA-F]{6})';/g)) {
  roles[m[1]] = m[2].toLowerCase();
}

/**
 * The six that MEAN something about a run, plus the two whose job is a device.
 *
 * Deliberately not "everything in theme.ts": the neutral ramp is allowed to appear
 * inline while screens are migrated, because a grey saying nothing cannot say the
 * wrong thing. These eight are the ones where a stray literal is a lie.
 */
const SEMANTIC = [
  'ACHIEVEMENT',
  'CAUTION',
  'METHOD',
  'EDITED',
  'DESTRUCTIVE',
  'INTERACTIVE',
  'LIVE',
  'LIVE_BUSY',
];

console.log('\n1. every semantic role exists and has a value');
{
  for (const name of SEMANTIC) truthy(`${name} is defined`, !!roles[name]);
  check('and the file defines more than just those', Object.keys(roles).length > SEMANTIC.length, true);
}

console.log('\n2. NO TWO JOBS SHARE A COLOUR');
{
  // The audit's finding, stated as a rule. Amber meant thirteen things and emerald
  // nine; "personal best" was two colours on one screen. Any repeat here is that
  // bug coming back, whatever the two jobs happen to be.
  const seen = new Map();
  const clashes = [];
  for (const [name, hex] of Object.entries(roles)) {
    // The deliberate ramps are one job at several weights, so they are grouped by
    // stem and compared as a unit rather than pairwise.
    const stem = name.replace(/_(STRONG|SOFT|FILL|EDGE|ON_BG|BRIGHT|2)$/, '');
    const key = `${stem}:${hex}`;
    if (seen.has(hex) && seen.get(hex) !== stem) clashes.push(`${hex} = ${seen.get(hex)} and ${stem}`);
    else seen.set(hex, stem);
    void key;
  }
  check('no colour is claimed by two different jobs', clashes, []);
}

console.log('\n3. NO SEMANTIC HEX IS TYPED INLINE anywhere in src/');
{
  // The rule that actually holds the line. A colour picked by NAME cannot be picked
  // by feel — and a new tag has to answer "which of the six is this?" before it can
  // be written, because there is nowhere else for it to go.
  const banned = new Map(SEMANTIC.map((n) => [roles[n], n]));
  const offences = [];
  for (const p of files) {
    const text = readFileSync(p, 'utf8');
    for (const m of text.matchAll(/#[0-9a-fA-F]{6}/g)) {
      const hex = m[0].toLowerCase();
      if (!banned.has(hex)) continue;
      const line = text.slice(0, m.index).split('\n').length;
      offences.push(`${relative(SRC, p).replace(/\\/g, '/')}:${line} ${hex} — import ${banned.get(hex)}`);
    }
  }
  check('no screen types a semantic colour directly', offences, []);
}

console.log('\n4. the roles are far enough apart to TELL apart');
{
  // A vocabulary of six words that sound alike is not six words. Hue distance is a
  // crude measure and it is the right kind of crude here: it catches "I added a
  // seventh role and picked a shade of the second".
  const hueOf = (hex) => {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    if (!d) return 0;
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  const sep = (a, b) => {
    const d = Math.abs(hueOf(roles[a]) - hueOf(roles[b]));
    return Math.min(d, 360 - d);
  };

  // ACHIEVEMENT and CAUTION are the deliberate exception and the scheme's weakest
  // point: gold and orange sit ~15 degrees apart. Accepted because they almost
  // never share a row — a personal best is by construction not a suspect run — and
  // recorded here so the exception is a decision rather than an oversight.
  truthy(`gold and orange are close, as accepted (${sep('ACHIEVEMENT', 'CAUTION').toFixed(0)}deg)`,
    sep('ACHIEVEMENT', 'CAUTION') < 30);

  const far = [
    ['ACHIEVEMENT', 'METHOD'],
    ['ACHIEVEMENT', 'EDITED'],
    ['ACHIEVEMENT', 'INTERACTIVE'],
    ['CAUTION', 'METHOD'],
    ['CAUTION', 'EDITED'],
    ['CAUTION', 'INTERACTIVE'],
    ['METHOD', 'EDITED'],
    ['METHOD', 'INTERACTIVE'],
    ['EDITED', 'INTERACTIVE'],
    ['EDITED', 'DESTRUCTIVE'],
    ['METHOD', 'DESTRUCTIVE'],
  ];
  const tooClose = far.filter(([a, b]) => sep(a, b) < 40).map(([a, b]) => `${a}/${b} ${sep(a, b).toFixed(0)}deg`);
  check('every other pair is at least 40 degrees apart', tooClose, []);
}

console.log('\n5. the jobs the audit reassigned really did move');
{
  // Named sites, so a revert shows up as a failure rather than as a slow drift back.
  const at = (rel) => readFileSync(join(SRC, rel), 'utf8');

  const detail = at('components/AthleteDetail.tsx');
  truthy('a personal best is ACHIEVEMENT in the run list', /runTimeBest: \{ color: ACHIEVEMENT/.test(detail));
  truthy('and BACKDATED is EDITED, not the same gold', /backdated: \{ color: EDITED/.test(detail));
  truthy('and the VIDEO tag is METHOD', /videoTimed: \{ color: METHOD/.test(detail));

  const chart = at('components/ProgressionChart.tsx');
  truthy('the chart PB matches the list PB', /pbTag: \{ color: ACHIEVEMENT/.test(chart));
  truthy('and so does its dot', /dotBest: \{ backgroundColor: ACHIEVEMENT/.test(chart));
  check('the dead trend tones are gone', /statGood|statBad/.test(chart), false);

  const history = at('screens/HistoryScreen.tsx');
  truthy('a hand start is METHOD, like video', /handTag: \{ color: METHOD/.test(history));
  truthy('a legacy record is EDITED', /legacyNote: \{ color: EDITED/.test(history));
  truthy("History's delete is the same red as the run list's", /delText: \{ color: DESTRUCTIVE/.test(history));
}

console.log('\n=============================');
console.log(failures === 0 ? 'RESULT: OK — every colour has one job.' : `RESULT: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
