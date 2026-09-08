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

/**
 * The file with its COMMENTS REMOVED, for any claim about prose.
 *
 * This file has now been bitten three times by guards matching the very comment
 * that explains the thing they assert: an ordering check that a comment mentioning
 * createRecorder() failed, an absence check for "BLE protocol", and a mutation that
 * survived because the phrase it removed from the UI still appeared in the note above
 * it. A claim about what the app SAYS has to read the code alone.
 */
const code = (abs) =>
  read(abs)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');

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
      what: 'Share log, in Diagnostics',
      file: 'screens/DebugScreen.tsx',
      where: ['<View style={styles.titleRow}>', '<PruneTestDataModal'],
      control: /onPress=\{\(\) => void shareEventLog\(\)\}/,
      label: /Share log/,
    },
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
    // HISTORY AND SETTINGS LEFT THE TAB BAR. Six tabs was two past what fits, and
    // neither is reached for mid-rep. Both now live in the same corner of the same
    // screen, which is what keeps it one pattern instead of two.
    {
      what: 'History, from the Roster header',
      file: 'screens/RosterScreen.tsx',
      where: ['<View style={styles.titleRow}>', '</View>' + String.fromCharCode(10) + '      </View>'],
      control: /onPress=\{onOpenHistory\}/,
      label: /History<\/Text>/,
    },
    {
      what: 'Settings, from the same header',
      file: 'screens/RosterScreen.tsx',
      where: ['<View style={styles.titleRow}>', '</View>' + String.fromCharCode(10) + '      </View>'],
      control: /onPress=\{onOpenSettings\}/,
      label: /accessibilityLabel="Settings"/,
    },
    {
      what: 'Diagnostics, from Settings',
      file: 'screens/SettingsScreen.tsx',
      where: ['{devVisible ? (', '</Section>'],
      control: /onPress=\{onOpenDebug\}/,
      label: /Diagnostics/,
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

console.log('\n5. WHAT A COACH MEETS, AND WHAT A REVIEWER MUST NOT');
{
  // The mirror of the rest of this file. Everywhere else asks whether a feature has
  // a way IN; this asks whether things that should be out of the way actually are.
  // Written for App Store submission, where a live button for a mode that cannot be
  // set up reads as an unfinished app rather than as a work in progress.
  const settings = read(join(SRC, 'screens', 'SettingsScreen.tsx'));
  const timer = read(join(SRC, 'screens', 'TimerScreen.tsx'));

  // DEV MODE IS NOT THE FIRST THING IN SETTINGS ANY MORE. It was a labelled switch
  // at the top — the most discoverable control on the screen — and turning it on
  // replaces clean results with raw values and opens Diagnostics.
  truthy('developer mode renders only once unlocked', /\{devVisible \? \(/.test(settings));
  truthy('and the unlock is a tap count on the version row',
    /onPress=\{\(\) => setVersionTaps\(\(n\) => n \+ 1\)\}/.test(settings));
  truthy('with a count high enough to be deliberate', /const DEV_UNLOCK_TAPS = ([7-9]|1[0-9]);/.test(settings));
  // Already on must stay visible, or dev mode could never be switched off again.
  truthy('an already-on dev mode shows its own switch',
    /const devVisible = devMode \|\| versionTaps >= DEV_UNLOCK_TAPS;/.test(settings));

  // REACTION IS SHELVED until the buzzer lands, so BOTH halves are gated together.
  // Leaving the button live while its calibration sat behind dev mode was the worst
  // of both: pressable, and impossible to set up.
  truthy('arming a reaction run is behind dev mode',
    /\{devMode \? \([\s\S]{0,200}Arm \(reaction\)/.test(timer));
  truthy('and so is the control that only a reaction run uses',
    /\{devMode \? \([\s\S]{0,400}Start sequence/.test(timer));
  check('no mode number is offered to a coach', /label="Arm Mode [12]"/.test(timer), false);

  // A FAILED SAVE MUST STILL SPEAK. The raw trace goes behind dev mode; the message
  // saying the run was not written does not, or the failure is silent.
  truthy('the raw timer trace is dev-only', /\{devMode && dbg \? /.test(timer));
  truthy('but a failed save is told to everyone', /\{saveError \? <Text/.test(timer));
  truthy('in words rather than an exception',
    /could not be saved to history/.test(timer));

  // A PLACEHOLDER URL IS A REJECTION. This shipped as example.com behind a TODO.
  check('the donate link is not a placeholder', /example\.com/.test(settings), false);
  truthy('and is a real destination', settings.includes('https://www.zeffy.com/'));

  // VERSION NUMBERS ARE OURS. A coach has no use for a BLE protocol number, and it
  // read as diagnostics sitting under the app version in About.
  // AGAINST THE MARKUP, not the file. The comment explaining this removal contains
  // the words it claims are gone, which is the same trap the ordering guards hit.
  check('About no longer states the BLE protocol',
    /label="BLE protocol"/.test(settings), false);
  truthy('and Diagnostics reports it instead',
    /proto app v\$\{PROTO_VERSION\}/.test(read(join(SRC, 'screens', 'DebugScreen.tsx'))));

  // The gate session line spoke in engine versions and state-machine phases.
  for (const f of ['DrillsScreen.tsx', 'TimerV2Screen.tsx']) {
    const src = read(join(SRC, 'screens', f));
    check(`${f} does not show an engine version`, /v2 · \{v2\.phase/.test(src), false);
    truthy(`${f} names the session in plain words`, /sessionLabel\(v2\.phase/.test(src));
  }
  truthy('and says what is missing when a gate has not joined',
    /Only one gate — the other has not joined yet/.test(read(join(SRC, 'screens', 'DrillsScreen.tsx'))));


  // A RUN THAT BELONGS TO NOBODY. History is the only screen that can change a
  // run's athlete, and the roster is organised BY athlete — so an unattributed run
  // appears under no one, which is exactly the run most likely to need fixing. The
  // chain that leads a coach to it is asserted end to end, because every link is
  // useless without the others: a count with no route is a nag, and a route with no
  // count is never taken.
  const roster = read(join(SRC, 'screens', 'RosterScreen.tsx'));
  truthy('the roster counts runs that belong to nobody', /countUnassignedRuns\(\)/.test(roster));
  truthy('and re-counts when History closes, not once on mount',
    /\}, \[historyOpen\]\);/.test(roster));
  truthy('the count is on the way in to History', /\{orphans > 0 \? \([\s\S]{0,200}orphanBadge/.test(roster));
  truthy('and says in words what it wants done',
    /saved without an athlete/.test(code(join(SRC, 'screens', 'RosterScreen.tsx'))));
  const hist = read(join(SRC, 'screens', 'HistoryScreen.tsx'));
  truthy('History says WHICH sessions hold them', /item\.unassignedCount > 0/.test(hist));
  truthy('and can still filter to them inside a session', /'Unassigned'/.test(hist));
  truthy('and History is the only screen that can reassign a run',
    /updateRunAthlete\(editing\.id/.test(hist));

  // FOUR TABS. The two that left must not still be there.
  const app = read(join(ROOT, 'App.tsx'));
  check('History is not a tab', /label="History"/.test(app), false);
  // FOUR LABELS, PINNED. A tab bar is the one place where a name is the whole
  // interface, and "Drills" collided with the Timer's drill LABEL — two different
  // things a coach would call the same word.
  for (const [label, id] of [['Timer', 'timer'], ['Modes', 'drills'], ['Roster', 'roster'], ['Video', 'video']]) {
    truthy(`the ${label} tab is there and named itself`,
      new RegExp(`label="${label}"[\\s\\S]{0,60}setTab\\('${id}'\\)`).test(app));
  }
  check('no tab is still called Drills', /label="Drills"/.test(app), false);
  check('Settings is not a tab', /label="Settings"/.test(app), false);
  truthy('and the overlay stack knows what closing Diagnostics returns to',
    /onBack=\{\(\) => setOverlay\('settings'\)\}/.test(app));
  truthy('with the dev-mode fallback following it there',
    /if \(!devMode && overlay === 'debug'\) setOverlay\('settings'\);/.test(app));
  truthy('and History reloading because it is OPEN, not because it is selected',
    /<HistoryScreen isActive onBack=/.test(app));

  // THE WAY OUT OF DEV MODE COMES BEFORE WHAT IT REVEALS. Turning it on inserts
  // four sections, and the toggle used to sit after them — so the switch that turns
  // it off was below everything it had just added. Reported from device as being
  // unable to turn it off at all. Read from the CODE, since the comment explaining
  // this names both sections.
  {
    const only = code(join(SRC, 'screens', 'SettingsScreen.tsx'));
    truthy('the dev-mode switch comes before the sections it reveals',
      only.indexOf('title="Developer mode"') < only.indexOf('title="Timing engine'));
    // The unlock stays at the bottom, on the version row, so the toggle is now
    // ABOVE what unlocks it. That is the trade: findable when on, which is what
    // was reported broken. The version row says where it went.
    truthy('and the unlock says where the switch appeared',
      /Developer mode is at the top of Settings/.test(only));
  }

  // COUNT BEFORE CLAIMING. `Both gates ready` fired whenever the gate list was
  // non-empty, so a one-gate session claimed two — the opposite of the miscount the
  // line exists to prevent, and unfalsifiable from the screen.
  for (const f of ['DrillsScreen.tsx', 'TimerV2Screen.tsx']) {
    const src = read(join(SRC, 'screens', f));
    truthy(`${f} counts the gates before saying both`, /if \(total >= 2\) return 'Both gates ready';/.test(src));
    truthy(`${f} says so when only one joined`, /total === 1/.test(src));
    check(`${f} leaks no phase name into a hint`, /Setting up gates… \(\$\{phase\}/.test(src), false);
  }

  // A badge that reads `set ?` is indistinguishable from something broken.
  const setctl = read(join(SRC, 'components', 'SetControl.tsx'));
  check('the set badge has no shrug state', /'set \?'/.test(setctl), false);
  truthy('it names the state instead', /SET UNKNOWN/.test(setctl));
}

console.log('\n=============================');
console.log(
  failures === 0
    ? 'RESULT: OK — every feature has a way in, and it is where you would look.'
    : `RESULT: ${failures} FAILURE(S)`,
);
process.exit(failures === 0 ? 0 : 1);
