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
      where: ['<View style={[styles.tabBar, { paddingBottom: tabBarBottomPad(insets) }]}>', '</View>'],
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
      where: ['<View style={[styles.swapRow, wide && styles.controlsInnerWide]}>', '</View>'],
      control: /onPress=\{\(\) => setRecordOpen\(true\)\}/,
      label: /Record another rep/,
    },
    {
      what: 'Import a different clip, with a clip loaded',
      file: 'screens/VideoMarkScreen.tsx',
      where: ['<View style={[styles.swapRow, wide && styles.controlsInnerWide]}>', '</View>'],
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

  // NO MODAL MOUNTS ALREADY OPEN, anywhere in src/.
  //
  // A modal host that mounts in the presented state asks UIKit to present during the
  // same commit that creates it, before the host has been laid out. When that
  // presentation is dropped you get a modal window with no content: invisible, eating
  // every touch, and undismissable because the backdrop was never laid out either.
  // Reported from device as History freezing when a run was tapped — and the run
  // editor was the ONLY place in the app doing this, against five modals on the same
  // screen that toggle `visible` on an always-mounted host and all work.
  //
  // Swept rather than pinned to one file, because the next one would look reasonable
  // in isolation too.
  {
    const offenders = [];
    // walk() returns ABSOLUTE paths — joining SRC again is how this first failed.
    for (const abs of walk(SRC)) {
      if (!/\.tsx$/.test(abs)) continue;
      if (/<Modal\s+visible(?![\w=])/.test(code(abs))) {
        offenders.push(abs.slice(abs.indexOf('src')));
      }
    }
    check('no modal is mounted already open', offenders, []);
  }

  // NO SHEET PRESENTS FROM INSIDE ANOTHER PRESENTED SHEET.
  //
  // iOS presents one modal at a time. A second request from inside the first is
  // DROPPED, and what it leaves behind is a modal window with no content: invisible,
  // swallowing every touch, and undismissable because its backdrop was never laid out.
  // Reported from device as the run editor's "assign athlete" doing nothing, and then
  // History being impossible to leave.
  //
  // SIX places did this, and a hand-written list of them missed one — which is the
  // argument for sweeping. Anything rendered inside a presented region must say
  // `embedded`, which is what tells SheetHost to render into the host already up
  // rather than ask for another.
  {
    // THE EXEMPTION IS A PROPERTY, NOT A LIST OF NAMES. UIKit genuinely stacks PAGE
    // SHEETS — presenting one from another is the card stack seen all over iOS, and it
    // works. What does not work is a transparent overlay presented over an existing
    // presentation, which is what froze History. So a component that presents a page
    // sheet may nest; everything else must embed.
    const presentsPageSheet = new Set();
    for (const abs of walk(SRC)) {
      if (!/\.tsx$/.test(abs)) continue;
      const src = code(abs);
      // A literal, or an expression that chooses between opaque styles by width —
      // AthleteDetail is full screen on an iPad and a page sheet on a phone. Both
      // stack; the thing that does not is a transparent overlay.
      if (!/presentationStyle=(?:"pageSheet"|\{[^}]*'pageSheet'[^}]*\})/.test(src)) continue;
      for (const m of src.matchAll(/export function (\w+)/g)) presentsPageSheet.add(m[1]);
    }
    truthy('the page-sheet exemption found something to exempt', presentsPageSheet.size > 0);
    truthy('and still covers the athlete page now that its style is chosen by width',
      presentsPageSheet.has('AthleteDetailModal'));

    // WHO OWNS A SHEET, read from the files rather than guessed from the NAME. The
    // first version matched tags ending in "Modal", so RenameDrillPrompt — a sheet
    // opened from inside the drill picker, which is itself opened from inside the run
    // editor — was invisible to it, and a mutation removing its guard survived. A
    // naming convention is not a property.
    // PER COMPONENT, not per file: a file holding a sheet also holds plain views,
    // and crediting all of them flagged <Row> and <PreviewLine> as sheets. Each
    // declaration owns the text up to the next one, which is enough because these
    // components are top level and sequential.
    const sheetOwners = new Set();
    const regions = [];
    for (const abs of walk(SRC)) {
      if (!/\.tsx$/.test(abs)) continue;
      const src = code(abs);
      const decls = [...src.matchAll(/function (\w+)/g)];
      for (let k = 0; k < decls.length; k += 1) {
        const from = decls[k].index;
        const to = k + 1 < decls.length ? decls[k + 1].index : src.length;
        const body = src.slice(from, to);
        regions.push([decls[k][1], body]);
        if (/<Modal|<SheetHost/.test(body)) sheetOwners.add(decls[k][1]);
      }
    }
    truthy('sheet owners were found by reading, not by naming', sheetOwners.size > 3);
    // AND OWNERSHIP IS TRANSITIVE. NoteWithMore never writes <SheetHost>; it renders
    // <LearnMore>, which does. Read literally, a <NoteWithMore> placed inside a
    // Modal would pass this sweep and present a second sheet on device. So anything
    // that renders a sheet owner is one, to a fixpoint.
    for (let grew = true; grew; ) {
      grew = false;
      for (const [name, body] of regions) {
        if (sheetOwners.has(name)) continue;
        for (const m of body.matchAll(/<([A-Z]\w*)\b/g)) {
          if (sheetOwners.has(m[1])) {
            sheetOwners.add(name);
            grew = true;
            break;
          }
        }
      }
    }
    truthy('a wrapper around a sheet counts as a sheet', sheetOwners.has('NoteWithMore'));

    const nested = [];
    for (const abs of walk(SRC)) {
      if (!/\.tsx$/.test(abs)) continue;
      const where = rel(abs);
      const src = code(abs);
      for (const [open, closeTag] of [['<Modal', '</Modal>'], ['<SheetHost', '</SheetHost>']]) {
        let i = src.indexOf(open);
        while (i !== -1) {
          // AFTER the opening tag, or a host matches itself and every host reads as
          // nested inside one.
          const bodyFrom = src.indexOf('>', i) + 1;
          const j = src.indexOf(closeTag, bodyFrom);
          const region = j === -1 ? src.slice(bodyFrom) : src.slice(bodyFrom, j);
          for (const m of region.matchAll(/<([A-Z]\w*)\b([^>]*)>/g)) {
            const tag = m[1];
            const attrs = m[2];
            if (!sheetOwners.has(tag)) continue;
            if (/\bembedded\b/.test(attrs)) continue;
            if (presentsPageSheet.has(tag)) continue;
            nested.push(where + ': <' + tag + '> inside a presented sheet, without embedded');
          }
          i = src.indexOf(open, i + 1);
        }
      }
    }
    check('no sheet presents from inside another sheet', nested, []);

    // AND AN EMBEDDED SHEET IS A DIRECT CHILD OF ITS HOST.
    //
    // A Modal is positioned against the window wherever it sits in the tree. An
    // embedded sheet fills its PARENT, so where it is written is where it appears.
    // The rename prompt was left buried inside the picker's card, was laid out
    // against the card's box rather than the screen, and its confirm button's label
    // was clipped out of the squeezed frame — reported as a button with no text.
    {
      const dp = code(join(SRC, 'components', 'DrillPicker.tsx'));
      // A ROW STYLE MUST NOT BE REUSED IN A COLUMN. `flex: 1` splits a row; in a
      // column it is flexBasis 0 on the main axis, so the control's HEIGHT collapses
      // to its padding and the label is clipped out — a blue box with no text. This
      // repo has had that bug twice now (9428397, and the run editor's Done button),
      // so the base style carries no flex and the row usages ask for the split.
      const histCode = code(join(SRC, 'screens', 'HistoryScreen.tsx'));
      check('the button base does not assume a row', /rmBtn: \{ flex: 1/.test(histCode), false);
      truthy('and the row usages ask for the split themselves',
        (histCode.match(/styles\.rmBtnFill/g) || []).length === 2);
      // AND THE EDITOR RE-READS THE ROW rather than patching its snapshot: it shows
      // the athlete NAME, which is resolved from the row, so setting only the id left
      // the old name on screen until the run was closed and reopened.
      truthy('a reassign re-reads the run from the database',
        /const rows = await refreshRuns\(\);[\s\S]{0,120}setEditing\(rows/.test(histCode));
      truthy('and so does a drill change',
        (histCode.match(/setEditing\(rows/g) || []).length === 2);

      truthy('the rename sheet is outside the card it was opened from',
        dp.indexOf('</KeyboardAvoidingView>') < dp.indexOf('<RenameDrillPrompt'));
    }
  }

  // AND THE ONE HOST THAT DECIDES. If SheetHost stops honouring `embedded`, every call
  // site above goes back to presenting and nothing else would notice.
  {
    // code(), not read(): a comment explaining the rule sits between the branch and
    // the line that implements it, and a window measured in characters counted it.
    const host = code(join(SRC, 'components', 'SheetHost.tsx'));
    truthy('an embedded sheet renders without presenting',
      /if \(embedded\) \{[\s\S]{0,220}absoluteFill/.test(host));
    truthy('and a root one still presents', /<Modal visible=\{visible\}/.test(host));
  }

  // WHAT A GLOVED THUMB HAS TO HIT, at a track, one-handed.
  //
  // Apple's floor is 44pt and these are the controls that get pressed during a
  // session, so they are held to 48. Sizes drift downward under layout pressure and
  // nothing else notices, which is what this is for — it reads the style values
  // rather than trusting a comment next to them.
  {
    // No regex for the lookup: the style key is found by string search and the body
    // taken to its closing brace. A generated pattern was the first attempt and its
    // escapes did not survive being written, which failed silently as 'not found'.
    const boxOf = (file, key) => {
      const src = code(join(SRC, file));
      const at = src.indexOf(key + ': {');
      if (at === -1) return null;
      const close = src.indexOf('}', at);
      const body = src.slice(at, close);
      const num = (prop) => {
        const i = body.indexOf(prop + ':');
        if (i === -1) return null;
        const v = parseInt(body.slice(i + prop.length + 1).trim(), 10);
        return Number.isFinite(v) ? v : null;
      };
      const h = num('minHeight') || num('height');
      if (h) return h;
      const pv = num('paddingVertical');
      // ~18pt for the line of label text these all contain.
      return pv === null ? null : pv * 2 + 18;
    };

    const MID_REP = [
      ['screens/TimerScreen.tsx', 'tagBar'],
      ['screens/TimerV2Screen.tsx', 'tagBar'],
      ['screens/DrillsScreen.tsx', 'tagBar'],
      ['screens/VideoMarkScreen.tsx', 'markBtn'],
      ['screens/VideoRecordModal.tsx', 'rate'],
      ['screens/RepeatsScreen.tsx', 'ivMerge'],
      ['screens/RepeatsScreen.tsx', 'ivDrop'],
      ['components/SetControl.tsx', 'tapTarget'],
      ['components/UpNextStrip.tsx', 'undoBtn'],
    ];
    const small = [];
    for (const [file, key] of MID_REP) {
      const box = boxOf(file, key);
      if (box === null) small.push(`${file}:${key} — style not found`);
      else if (box < 48) small.push(`${file}:${key} is ${box}pt, under 48`);
    }
    check('every mid-rep control is at least 48pt', small, []);

    // The corner exits and the row icons: a BOX, not hitSlop. Slop cannot be seen,
    // half of it falls off the screen edge where these live, and overlapping slop
    // makes neighbouring controls steal each other's taps.
    const hist = code(join(SRC, 'screens', 'HistoryScreen.tsx'));
    truthy('the exits have a real box', /backBtn: \{ paddingVertical: 1[2-9]/.test(hist));
    truthy('and both use it', (hist.match(/style=\{styles\.backBtn\}/g) || []).length === 2);
    check('no exit relies on hitSlop', /hitSlop=\{10\}>\s*<Text style=\{styles\.back\}/.test(hist), false);
    truthy('the row icons are a real box too', (boxOf('screens/HistoryScreen.tsx', 'rowIcon') || 0) >= 44);
    check('and no longer overlap each other', /hitSlop=\{8\}[\s\S]{0,40}styles\.rowIcon/.test(hist), false);
  }

  // The tab bar: the most-pressed control in the app.
  {
    const app = code(join(ROOT, 'App.tsx'));
    truthy('the tab bar target is 48pt', /tab: \{ flex: 1, alignItems: 'center', paddingVertical: 15 \}/.test(app));
    truthy('with the bar top padding moved into it rather than added on top',
      /paddingTop: 0,/.test(app));
  }

  // A badge that reads `set ?` is indistinguishable from something broken.
  const setctl = read(join(SRC, 'components', 'SetControl.tsx'));
  check('the set badge has no shrug state', /'set \?'/.test(setctl), false);
  truthy('it names the state instead', /SET UNKNOWN/.test(setctl));
  // THE SCREEN IS NOT THE MANUAL. A copy pass before submission found the app
  // explaining itself in the main view — a six-line accuracy paragraph under every
  // clip, the probe trace beside it, protocol state names in the Timer's status
  // line, M-numbers on History rows, "B1" and "event stream" in the one Settings
  // section a coach sees. None of it is cut; it moves behind Learn more or dev mode.
  // Every claim here reads code(), not prose, because each of these words still
  // appears in the comment that explains its removal.
  {
    const mark = code(join(SRC, 'screens', 'VideoMarkScreen.tsx'));
    truthy('the video accuracy caveat is one line with a Learn more',
      /<NoteWithMore\s+note="Video timing is not gate-accurate/.test(mark));
    truthy('and the sheet still carries the body-part figure', /\$\{BODY_PART_BIAS_MS\}ms on its own/.test(mark));
    truthy('and the whole-frame claim', /whole frame, the worst case, not a statistical spread/.test(mark));
    check('no accuracy paragraph remains in the main view', /styles\.caveat/.test(mark), false);
    truthy('the probe trace is dev-only', /\{devMode && perf \? <Text/.test(mark));
    check('and is no longer joined into the facts line', /describeClip\(clip\.bytes, duration\),\s*perf,/.test(mark), false);

    const record = code(join(SRC, 'screens', 'VideoRecordModal.tsx'));
    check('the camera note does not narrate the post-check', /it is the file that decides/.test(record), false);
    truthy('that fact moved to the marking sheet', /it is the file that decides/.test(mark));

    const timerCode = code(join(SRC, 'screens', 'TimerScreen.tsx'));
    truthy('the Timer status line speaks the coach’s words unless in dev mode',
      /devMode \? STATE_NAME\[gateStatus\.state\] \?\? '' : gateStateLabel\(gateStatus\.state\)/.test(timerCode));
    truthy('and that label covers every gate state', /case GateState\.M2ToGate2:\s*return 'Running'/.test(timerCode));
    check('the idle hint no longer offers a choice of modes', /'Pick a mode to arm\.'/.test(timerCode), false);
    const cleanBlock = timerCode.slice(
      timerCode.indexOf("result.mode === 2 && !devMode"),
      timerCode.indexOf('result.mode === 2 && devMode'),
    );
    truthy('the clean reaction block was found', cleanBlock.length > 100);
    check('and it does not abbreviate the gates', /G1|G2/.test(cleanBlock), false);

    // The same trace/notice split the Timer got, on the other two screens that save.
    for (const f of ['DrillsScreen.tsx', 'RepeatsScreen.tsx']) {
      const src = code(join(SRC, 'screens', f));
      truthy(`${f}: the raw trace is dev-only`, /\{devMode && dbg \? <Text/.test(src));
      truthy(`${f}: but a failed save is told to everyone`, /\{note \? <Text/.test(src));
      truthy(`${f}: in words rather than an exception`, /could not be saved to history/.test(src));
    }
    truthy('an unsynced drill rep says so in plain words',
      /The two gates were not in sync for that rep, so its time was not saved\./.test(code(join(SRC, 'screens', 'DrillsScreen.tsx'))));
    check('the drill hint no longer mentions the session',
      /a drill needs the session up/.test(code(join(SRC, 'screens', 'DrillsScreen.tsx'))), false);

    const repeats = code(join(SRC, 'screens', 'RepeatsScreen.tsx'));
    truthy('the rest-rep explanation is one line with a Learn more', /<NoteWithMore\s+note=\{`Tap Start rep;/.test(repeats));
    truthy('and the sheet keeps the hand-timing figure', /HAND_START_ERROR_MS\}ms of hand-timing error/.test(repeats));
    truthy('the lap-repair explanation is one line with a Learn more', /<NoteWithMore\s+note="Join merges/.test(repeats));
    truthy('and the sheet keeps what End here does', /discards the final split and ends the set at the previous crossing/.test(repeats));

    const tab = code(join(SRC, 'screens', 'DrillsTab.tsx'));
    truthy('the Modes tab header says MODE', /<Text style=\{styles\.kicker\}>MODE<\/Text>/.test(tab));
    truthy('and so does its picker', /<Text style=\{styles\.cardTitle\}>Mode<\/Text>/.test(tab));

    const hist = code(join(SRC, 'screens', 'HistoryScreen.tsx'));
    check('History rows do not print a mode number', /<Text style=\{styles\.runMode\}>M\{item\.mode\}/.test(hist), false);
    truthy('they name the mode', /<Text style=\{styles\.runMode\}>\{modeLabel\(item\.mode\)\}/.test(hist));
    truthy('and so does the average', /modeLabel\(\[\.\.\.modeSet\]\[0\]\)/.test(hist));
    check('the reaction caption does not abbreviate the gates', /G1→G2/.test(hist), false);
    truthy('a hand-started run says so in a word a coach uses', /styles\.handTag\}>hand-started</.test(hist));

    const settingsCode = code(join(SRC, 'screens', 'SettingsScreen.tsx'));
    const coachSection = settingsCode.slice(
      settingsCode.indexOf('<Section title="Runs started at the gate">'),
      settingsCode.indexOf('</Section>', settingsCode.indexOf('<Section title="Runs started at the gate">')),
    );
    truthy('the coach-visible Settings section exists', coachSection.length > 100);
    // WHAT IS ALWAYS ON SCREEN: the switch label and the one-line note. The sheet
    // body is allowed the full account, so it is excluded — and a first draft of
    // this guard checked only the text before <NoteWithMore, which is the label and
    // nothing else, and let a mutation of the note itself through.
    const visible = [
      (coachSection.match(/<Text style=\{styles\.devLabel\}>([\s\S]*?)<\/Text>/) || [])[1] || '',
      (coachSection.match(/note="([^"]*)"/) || [])[1] || '',
    ].join(' ');
    truthy('with a label and a note to read', visible.length > 60);
    for (const ours of ['B1', 'B2', 'Mode-1', 'Mode-2', 'event stream', 'app-armed']) {
      check(`and neither says "${ours}"`, visible.includes(ours), false);
    }
    truthy('while the sheet keeps the two-button caveat', /cannot tell the app which of its two buttons/.test(coachSection));
    check('About does not name the radio protocol', /ESP-NOW/.test(settingsCode), false);
    truthy('but still says the phone is out of the timing path', /phone is never in the timing path/.test(settingsCode));

    // THE EXPERIMENTAL TIMER IS BEHIND DEV MODE, NOT BEHIND ITS OWN TOGGLE. The
    // toggle is only rendered inside the dev section, but its value persists — so
    // dev mode off with the toggle still set left the Timer tab on TimerV2Screen,
    // which says "v2 engine" and "Mode-1", with no visible way back. The tab must
    // read both flags.
    const appCode = code(join(ROOT, 'App.tsx'));
    truthy('the experimental timer needs dev mode as well as its toggle',
      /\{devMode && useV2Engine \? <TimerV2Screen \/> : <TimerScreen \/>\}/.test(appCode));
    check('and is never chosen on the toggle alone', /\{useV2Engine \? <TimerV2Screen/.test(appCode), false);

    // The athlete page's "No drill" card states the fact and not the argument.
    const detail = code(join(SRC, 'components', 'AthleteDetail.tsx'));
    truthy('the No drill card says runs without a drill are not charted',
      /Runs without a drill are not\s+charted\./.test(detail));
    check('without arguing the point', /share nothing but the missing label/.test(detail), false);
  }
}

console.log('\n6. THE SCREEN FITS THE DEVICE IT IS ON');
{
  // Every screen was laid out for one shape — a Dynamic Island phone, upright —
  // with its insets written down as numbers. On a 13-inch iPad that opened each
  // screen with a 32pt dead band and stretched phone-proportioned content across
  // 1032pt. The insets are measured now and the wide layouts key off width, and
  // this pins both so the numbers cannot creep back.
  const layout = code(join(SRC, 'layout.ts'));
  truthy('wide is decided by width, not by device',
    /wide: width >= WIDE_MIN_WIDTH/.test(layout) && !/isPad|Platform/.test(layout));
  const threshold = Number((layout.match(/WIDE_MIN_WIDTH = (\d+)/) || [])[1]);
  truthy('and the threshold clears every phone upright (430) but not the iPad mini (744)',
    threshold > 430 && threshold <= 744);
  truthy('the tab bar keeps its phone padding and drops the dead space elsewhere',
    /Math\.min\(insets\.bottom, 24\)/.test(layout));

  // NO INSET IS A NUMBER ANY MORE.
  const screens = [
    'screens/TimerScreen.tsx', 'screens/TimerV2Screen.tsx', 'screens/DrillsScreen.tsx',
    'screens/DrillsTab.tsx', 'screens/RepeatsScreen.tsx', 'screens/RosterScreen.tsx',
    'screens/HistoryScreen.tsx', 'screens/SettingsScreen.tsx', 'screens/DebugScreen.tsx',
    'screens/VideoMarkScreen.tsx', 'screens/VideoLibraryScreen.tsx',
  ];
  for (const f of screens) {
    const src = code(join(SRC, f));
    check(`${f} has no hard-coded status-bar padding`, /paddingTop: 5[0-9]/.test(src), false);
    truthy(`${f} reads the inset instead`, /topPad\(insets/.test(src));
  }
  const app = code(join(ROOT, 'App.tsx'));
  truthy('the insets are provided at the root, with the metrics native measured first',
    /<SafeAreaProvider initialMetrics=\{initialWindowMetrics\}>/.test(app));
  truthy('and the tab bar reads its bottom inset', /paddingBottom: tabBarBottomPad\(insets\)/.test(app));
  check('rather than assuming a home indicator', /paddingBottom: 24,/.test(app), false);

  // THE READOUT SCALES; THE CONTROLS ARE CAPPED. A 76pt number in a 1032pt space
  // with a 1000pt Arm button under it is the phone layout stretched.
  const timer = code(join(SRC, 'screens', 'TimerScreen.tsx'));
  truthy('the Timer caps its column on wide screens', /wide && styles\.containerWide/.test(timer));
  truthy('and grows the readout', /timerWide: \{ fontSize: 1[0-9][0-9] \}/.test(timer));
  truthy('the Modes tab caps its column', /wide && styles\.rootWide/.test(code(join(SRC, 'screens', 'DrillsTab.tsx'))));
  const drills = code(join(SRC, 'screens', 'DrillsScreen.tsx'));
  truthy('the drill stage takes the leftover height on wide screens', /wide && styles\.stageFill/.test(drills));
  truthy('through flexGrow on the scroll content, so it still scrolls', /contentFill: \{ flexGrow: 1 \}/.test(drills));
  truthy('and keeps its floor, because flex: 1 alone collapses (see 9428397)',
    /stage: \{[^}]*minHeight: 260/.test(drills));
  truthy('and grows the readout', /timerWide: \{ fontSize: 1[0-9][0-9] \}/.test(drills));
  truthy('Settings is a centred column on wide screens',
    /wide && styles\.bodyWide/.test(code(join(SRC, 'screens', 'SettingsScreen.tsx'))));
  const mark = code(join(SRC, 'screens', 'VideoMarkScreen.tsx'));
  truthy('the marking controls are capped below the strip', /wide && styles\.controlsInnerWide/.test(mark));
  check('but the strip itself is not — width is scrub precision',
    /styles\.strip,[^\]]*Wide/.test(mark), false);
  truthy('the video library wraps into columns on wide screens',
    /columns > 1 && styles\.cardsGrid/.test(code(join(SRC, 'screens', 'VideoLibraryScreen.tsx'))));

  // THE ATHLETE PAGE FILLS AN IPAD. A page sheet there is a centred card with the
  // roster showing through around it. Master-detail is 1.1.
  const detail = code(join(SRC, 'components', 'AthleteDetail.tsx'));
  truthy('the athlete page is full screen on wide screens and a page sheet on a phone',
    /presentationStyle=\{wide \? 'fullScreen' : 'pageSheet'\}/.test(detail));
  // AND ITS PAGER SURVIVES A ROTATION. pageW re-measures; the offset did not.
  truthy('the chart pager puts its offset back when its width changes',
    /useEffect\(\(\) => \{\s*if \(pageW > 0\) ref\.current\?\.scrollTo\(\{ x: pageRef\.current \* pageW, animated: false \}\);\s*\}, \[pageW\]\);/.test(detail));

  // THE ORPHAN COUNT IS A BADGE, NOT A SENTENCE. The words live on as the button's
  // accessibility label, which is what the earlier "says in words" guard now reads.
  const roster = code(join(SRC, 'screens', 'RosterScreen.tsx'));
  check('the roster no longer prints an orphan sentence', /styles\.orphanNote/.test(roster), false);
  truthy('the History button carries the count for a screen reader',
    /accessibilityLabel=\{\s*orphans > 0\s*\?/.test(roster));
}

console.log('\n=============================');
console.log(
  failures === 0
    ? 'RESULT: OK — every feature has a way in, and it is where you would look.'
    : `RESULT: ${failures} FAILURE(S)`,
);
process.exit(failures === 0 ? 0 : 1);
