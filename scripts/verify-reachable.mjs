// Can a coach actually GET to it?
//
//   node scripts/verify-reachable.mjs
//
// This exists because the same failure has now shipped twice, and both times the
// logic was verified and the way in was not.
//
//   9ca6340  An Unlabelled chart page that could be swiped to and never displayed:
//            the pager clamped to series.length while the page COUNT was
//            series.length + 1, so landing on it set the page and an effect pulled
//            it straight back. Found by audit.
//   fa89edd  A recording feature with twelve green assertions over its rules and no
//            button in the pane a coach with no clip is looking at. Found on device,
//            by the person who could not find it.
//
// Neither was a subtle defect. Both were total: the code was correct, the suite was
// green, and the feature did not exist as far as anyone using the app could tell.
// A test that proves a rule fires says nothing about whether anything can fire it.
//
// So there are two halves here, and the split matters.
//
//   PART 1 is AUTOMATIC and cannot be forgotten. It walks the import graph from
//   App.tsx and fails on any screen or component nothing renders. A new screen wired
//   to nothing fails the moment it is written — nobody has to remember to add a
//   check, which is the whole point, because remembering is exactly what failed.
//
//   PART 2 is DECLARED, because no graph walk can know that "Record a rep" belongs
//   in the empty state rather than merely somewhere in the file. Every user-facing
//   way IN gets an entry. Adding one is three lines; the cost of not having one is
//   above.
//
// Reads source as text, like verify-theme. That is deliberate: it is checking what
// someone can reach, not what a render happens to produce today.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SRC = join(ROOT, 'src');

let failures = 0;
const check = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n         got  ${g}\n         want ${w}`}`);
};
const truthy = (label, v) => check(label, !!v, true);

/** Line endings normalised at read. A guard that stops matching does not fail
 *  loudly — it passes — and git hands these files over with CRLF on Windows. */
const read = (abs) => readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');

const rel = (abs) => relative(ROOT, abs).replace(/\\/g, '/');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/** Resolve a relative import the way Metro does, extensionless. */
function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const cand of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

const importsOf = (text) =>
  [...text.matchAll(/(?:from|import)\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1]);

// --------------------------------------------------------------- the graph

/**
 * Everything the running app can actually load, from the root inwards.
 *
 * App.tsx, not index.ts, because index.ts only registers the root component. If a
 * second entry point ever appears it belongs in this list, and forgetting it would
 * show up as a wave of false orphans rather than as silence.
 */
const ENTRY = join(ROOT, 'App.tsx');

const reachable = new Set();
{
  const queue = [ENTRY];
  while (queue.length) {
    const f = queue.pop();
    if (reachable.has(f)) continue;
    reachable.add(f);
    for (const spec of importsOf(read(f))) {
      const target = resolveImport(f, spec);
      if (target) queue.push(target);
    }
  }
}

/** Component names a file exports — default or named, PascalCase only. */
function exportedComponents(text, path) {
  const names = new Set();
  for (const m of text.matchAll(/export\s+(?:default\s+)?function\s+([A-Z]\w*)/g)) names.add(m[1]);
  for (const m of text.matchAll(/export\s+const\s+([A-Z]\w*)\s*[:=]/g)) names.add(m[1]);
  // `export default function Foo` is caught above; a bare `export default Foo`
  // still names the component it re-exports.
  for (const m of text.matchAll(/export\s+default\s+([A-Z]\w*)\s*;/g)) names.add(m[1]);
  // A default-exported screen may be anonymous at the export site and named only by
  // its file. Metro imports it by whatever the importer calls it, which by
  // convention here is the filename.
  const base = path.split(/[\\/]/).pop().replace(/\.tsx?$/, '');
  if (/export\s+default\s+function\s*\(/.test(text) && /^[A-Z]/.test(base)) names.add(base);
  return [...names];
}

console.log('\n1. EVERY SCREEN AND COMPONENT IS RENDERED BY SOMETHING');
{
  // The automatic half. Not a list anyone maintains — the set is whatever is on
  // disk, so a new file is covered the moment it exists.
  //
  // A file counts as mounted when some OTHER reachable file contains `<Name`. Not
  // "is imported": the Unlabelled page was imported, and the recording sheet would
  // have been too. Rendering is the claim worth making.
  const files = walk(SRC).filter((p) => /[\\/](screens|components)[\\/]/.test(p));

  /**
   * Deliberately unmounted, with the reason. An entry here is a DECISION on record;
   * an orphan without one is a failure. Empty today, and it should stay hard to add
   * to — "we will wire it up later" is what both of the shipped bugs were.
   */
  const ALLOWED_ORPHANS = {};

  const jsxIndex = new Map();
  for (const f of reachable) jsxIndex.set(f, read(f));

  const orphans = [];
  for (const f of files) {
    const names = exportedComponents(read(f), f);
    if (!names.length) continue;
    const mountedBy = [...jsxIndex.entries()].filter(
      ([other, text]) => other !== f && names.some((n) => new RegExp(`<${n}[\\s/>]`).test(text)),
    );
    if (mountedBy.length) continue;
    if (ALLOWED_ORPHANS[rel(f)]) continue;
    orphans.push(`${rel(f)} exports ${names.join(', ')} and nothing renders it`);
  }
  check('nothing on disk is stranded', orphans, []);

  // And the walk itself has to be working. If ENTRY stopped resolving imports this
  // block would pass by finding nothing, which is the vacuous-guard failure again.
  truthy('the import graph actually walked', reachable.size > 20);
  truthy('and reached the deepest leaves', [...reachable].some((p) => /video[\\/]timing\.ts$/.test(p)));
}

console.log('\n2. EVERY WAY IN IS WHERE A COACH WOULD LOOK');
{
  // The declared half. A graph walk can prove the recording sheet is mounted; it
  // cannot know the button belongs in the pane shown when there is no clip yet —
  // which is exactly the state the feature was reported missing from.
  //
  // `where` slices the region before searching, so a control elsewhere in the same
  // file cannot satisfy the claim. That slice is the assertion.
  const ENTRY_POINTS = [
    {
      what: 'Record a rep',
      file: 'screens/VideoMarkScreen.tsx',
      where: ['{!clip ? (', '      ) : ('],
      control: /onPress=\{\(\) => setRecordOpen\(true\)\}/,
      label: /Record a rep/,
    },
    {
      what: 'Import a clip',
      file: 'screens/VideoMarkScreen.tsx',
      where: ['{!clip ? (', '      ) : ('],
      control: /onPress=\{pick\}/,
      label: /Import a clip/,
    },
    {
      what: 'the Video tab itself',
      file: '../App.tsx',
      where: ['<View style={styles.tabBar}>', '</View>'],
      control: /onPress=\{\(\) => setTab\('video'\)\}/,
      label: /label="Video"/,
    },
    {
      what: 'the Videos pane, beside Mark',
      file: 'screens/VideoTab.tsx',
      where: ['<View style={styles.switch}>', '</View>'],
      control: /onPress=\{\(\) => setPane\('library'\)\}/,
      label: /label="Videos"/,
    },
    // The second way in, once a clip is already loaded. Without these the only
    // route back to the camera is finishing or discarding whatever is on screen —
    // reachable in the graph sense, unreachable in the sense that matters.
    {
      what: 'Record another rep, with a clip loaded',
      file: 'screens/VideoMarkScreen.tsx',
      where: ['<View style={styles.swapRow}>', '</View>'],
      control: /onPress=\{\(\) => setRecordOpen\(true\)\}/,
      label: /Record another rep/,
    },
    {
      what: 'Import a different clip, with a clip loaded',
      file: 'screens/VideoMarkScreen.tsx',
      where: ['<View style={styles.swapRow}>', '</View>'],
      control: /onPress=\{pick\}/,
      label: /Import a different clip/,
    },
  ];

  for (const e of ENTRY_POINTS) {
    const text = read(join(SRC, e.file));
    const from = text.indexOf(e.where[0]);
    const to = from === -1 ? -1 : text.indexOf(e.where[1], from + e.where[0].length);
    if (from === -1 || to === -1) {
      check(`${e.what}: the region it lives in still exists`, { from, to }, 'both found');
      continue;
    }
    const region = text.slice(from, to);
    truthy(`${e.what} is present where a coach looks`, e.control.test(region));
    truthy(`${e.what} is labelled as itself`, e.label.test(region));
  }
}

console.log('\n3. A SHEET HANDS BACK WHAT IT WAS OPENED FOR');
{
  // A third flavour of the same failure: a way in that works and a way OUT that
  // drops the result. The coach films a rep, the sheet closes, and nothing arrives —
  // no error, no clip on screen, and a file sitting in Videos that looks like a bug.
  //
  // Moved here from verify-capture, which had grown its own reachability block. Two
  // homes for "can you get to it" is how one of them ends up not being read.
  const mark = read(join(SRC, 'screens', 'VideoMarkScreen.tsx'));

  truthy('the marking screen imports the camera sheet', /import \{ VideoRecordModal.*\} from '\.\/VideoRecordModal'/.test(mark));
  truthy('mounts it against the flag the button sets', /<VideoRecordModal[\s\S]{0,200}visible=\{recordOpen\}/.test(mark));
  truthy('can close it again', /onCancel=\{\(\) => setRecordOpen\(false\)\}/.test(mark));
  truthy('and does something with what it produces', /onRecorded=\{\(r\) => void onRecorded\(r\)\}/.test(mark));

  // MOUNTED OUTSIDE THE BRANCH IT IS OPENED FROM. Inside the empty state, the sheet
  // unmounts the instant a recording lands and setClip flips the branch — taking
  // itself down mid-dismissal. Compared by position rather than matched against
  // prose spanning two lines, which is what it did first and what CRLF broke.
  truthy(
    'and is mounted outside the branch it is opened from',
    mark.lastIndexOf('</ScrollView>') < mark.indexOf('<VideoRecordModal'),
  );
}

console.log('\n4. AND A DESTINATION THAT EXISTS CAN BE DISPLAYED');
{
  // The OTHER way this fails, and the one that shipped first. The Unlabelled page
  // was mounted, was in the right place, and had a control that reached it — and a
  // clamp effect pulled the pager back the instant it arrived, because the clamp
  // counted series while the pager counted series plus the appended page.
  //
  // Text cannot prove a clamp is right. What it can do is pin the two numbers to the
  // SAME expression, which is the shape the bug had: two counts that must agree,
  // written independently, agreeing until an athlete had one real drill.
  const detail = read(join(SRC, 'components', 'AthleteDetail.tsx'));
  truthy('the pager has one page count', /const pageCount = series\.length \+ \(hasUnlabeled \? 1 : 0\)/.test(detail));
  truthy('and the clamp uses it rather than series.length', /if \(page > pageCount - 1\)/.test(detail));
  check('no clamp counts series directly any more', /page > series\.length/.test(detail), false);
}

console.log('\n=============================');
console.log(
  failures === 0
    ? 'RESULT: OK — every feature has a way in, and it is where you would look.'
    : `RESULT: ${failures} FAILURE(S)`,
);
process.exit(failures === 0 ? 0 : 1);
