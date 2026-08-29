// Prove the recording budget before a phone can be filled by a feature nobody
// asked to fill it.
//
//   node scripts/verify-storage.mjs
//
// Imports src/video/storage.ts directly, and src/video/capture.ts alongside it —
// the storage triad is a cap, a space guard and a default, and the default lives
// with the frame-rate rule. Asserting it from here is what makes "the triad" a
// thing that exists rather than a phrase in a commit message.
//
// THE CLAIM THAT MATTERS: no number in this module predicts what a clip will cost.
// Three clips at identical 1080p120 measured 2.3, 8.7 and 24.8 Mbps — fifteen-fold
// from content alone — so every projection is a number with no error bar. Block 6
// is the structural guard for that: it reads the source as text and fails if a
// per-minute figure can reach the screen.

import { DEFAULT_FPS } from '../src/video/capture.ts';
import {
  MAX_CLIP_MS,
  MIN_RECORD_BUDGET_BYTES,
  RECORD_RESERVE_BYTES,
  budgetForRecording,
  describeClip,
  endedBecause,
  misTapNote,
  MIN_CLIP_MS,
  formatBytes,
} from '../src/video/storage.ts';
import { acceptRecording } from '../src/video/capture.ts';

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0;
const check = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n         got  ${g}\n         want ${w}`}`);
};
const truthy = (label, v) => check(label, !!v, true);

const MB = 1024 * 1024;

console.log('\n1. THE TRIAD — a cap, a budget floor, and a default');
{
  // Each is a decision with an argument behind it, so each is pinned. Changing one
  // should mean rewriting its argument, not editing a number in passing.
  check('the cap is 30 seconds', MAX_CLIP_MS, 30_000);
  check('expressed in whole seconds, because the recorder takes seconds', MAX_CLIP_MS / 1000, 30);
  check('the reserve is 250MB', RECORD_RESERVE_BYTES, 250 * MB);
  check('the floor is 40MB', MIN_RECORD_BUDGET_BYTES, 40 * MB);
  check('and the default rate is 120', DEFAULT_FPS, 120);

  // The floor has to be a real amount and still far below the reserve, or the guard
  // is either useless or refuses phones that are fine.
  truthy('the floor is smaller than the reserve', MIN_RECORD_BUDGET_BYTES < RECORD_RESERVE_BYTES);
  truthy('and it is not zero', MIN_RECORD_BUDGET_BYTES > 0);
}

console.log('\n2. THE BUDGET IS CUT FROM MEASURED FREE SPACE, not from a rate');
{
  // The distinction the whole module rests on. A projection would return the same
  // ceiling on every phone; a budget tracks the disk it was measured from.
  const roomy = budgetForRecording(4 * 1024 * MB);
  check('a phone with 4GB free may record', roomy.ok, true);
  check('and its ceiling is free minus the reserve', roomy.budgetBytes, 4 * 1024 * MB - RECORD_RESERVE_BYTES);
  check('nothing to warn about', roomy.warn, null);

  const tighter = budgetForRecording(1024 * MB);
  truthy('a phone with less free gets a smaller ceiling', tighter.budgetBytes < roomy.budgetBytes);
  check('by exactly the difference in free space', roomy.budgetBytes - tighter.budgetBytes, 3 * 1024 * MB);
}

console.log('\n3. THE FLOOR REFUSES BEFORE THE REP, not during it');
{
  // Without it the guard degrades absurdly instead of refusing: a 1MB ceiling is
  // met in a fraction of a second and the coach has run a rep for nothing.
  const broke = budgetForRecording(260 * MB);
  check('260MB free is refused', broke.ok, false);
  truthy('and the refusal quotes what is actually free', /260 MB/.test(broke.reason));
  truthy('and what the app keeps clear', /250 MB/.test(broke.reason));
  truthy('and says what to do about it', /Delete some clips|import a rep/i.test(broke.reason));
  truthy('without claiming what a clip would have cost', !/would (need|use|cost)/i.test(broke.reason));

  // Both sides of the boundary, so the comparison cannot silently become >=.
  check('exactly reserve + floor is allowed', budgetForRecording(RECORD_RESERVE_BYTES + MIN_RECORD_BUDGET_BYTES).ok, true);
  check('one byte under is refused', budgetForRecording(RECORD_RESERVE_BYTES + MIN_RECORD_BUDGET_BYTES - 1).ok, false);

  check('an empty disk is refused', budgetForRecording(0).ok, false);
  // A negative reading is nonsense, and nonsense must not read as "plenty".
  check('and so is a negative reading', budgetForRecording(-1).ok, false);
  truthy('which does not print a negative size', !/-\d/.test(budgetForRecording(-1).reason));
}

console.log('\n4. AN UNREADABLE DISK IS A WARNING HERE AND A REFUSAL THERE');
{
  // The deliberate asymmetry with capture.ts, asserted directly so it reads as a
  // decision rather than as two modules that disagree.
  //
  // A frame rate that cannot be read means a time may be wrong by a factor of eight
  // and look right forever after: silent, permanent, uncorrectable. Free space that
  // cannot be read means the disk might fill: loud, visible, and still bounded by
  // MAX_CLIP_MS. One earns a refusal. The other earns a warning and the backstop.
  const blind = budgetForRecording(Number.NaN);
  check('an unreadable disk still allows recording', blind.ok, true);
  check('with no byte ceiling at all', blind.budgetBytes, null);
  truthy('but says so', /did not report/i.test(blind.warn));
  truthy('and names the limit that is left', /30 second/.test(blind.warn));
  check('Infinity is treated the same way', budgetForRecording(Number.POSITIVE_INFINITY).budgetBytes, null);

  check('while an unreadable FRAME RATE is refused', acceptRecording(120, 120, null).ok, false);
}

console.log('\n5. AN AUTO-STOP IS NOT A FAILURE, and has to say so');
{
  // A recording that halts by itself reads as truncated footage, and a coach who
  // believes that re-runs a rep that was captured perfectly well. VisionCamera
  // finalizes the file in both cases; only the length was decided by something
  // other than the finger.
  const dur = endedBecause('max-duration-reached');
  truthy('the duration cap names the limit', /30 second/.test(dur));
  truthy('and says the clip is complete', /complete/i.test(dur));
  truthy('and that it can be marked', /mark/i.test(dur));

  const size = endedBecause('max-file-size-reached');
  truthy('the byte ceiling explains itself as space', /space/i.test(size));
  truthy('and also says complete', /complete/i.test(size));
  truthy('and admits it is shorter than asked for', /shorter/i.test(size));

  // A stop the coach performed needs no explanation, and an alert that always fires
  // stops being read.
  check('a finger on the button says nothing', endedBecause('stopped'), null);
}

console.log('\n6. NOTHING PROJECTS A RATE — the structural guard');
{
  // Read as text, like verify-theme, and for the same reason: this is checking what
  // someone can type, not what happens to render today. A measured MB/min for one
  // clip is that clip's SCENE, and putting it on screen invites multiplying it by a
  // session.
  //
  // Comment lines are stripped first, because the argument for the rule cites the
  // very numbers the rule bans. Only lines that START with // or * are treated as
  // comments — a trailing comment is left in place, so this can produce a false
  // alarm but never a false pass.
  const HERE = fileURLToPath(new URL('.', import.meta.url));
  const SRC = join(HERE, '..', 'src');
  const walk = (dir) => {
    const out = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...walk(p));
      else if (/\.tsx?$/.test(p)) out.push(p);
    }
    return out;
  };
  const strip = (text) =>
    text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');

  const BANNED = /MB\s*\/\s*min|MB per minute|per\s*minute|perMin|megabytes per/i;
  const offences = [];
  for (const p of walk(SRC)) {
    const lines = strip(readFileSync(p, 'utf8').replace(/\r\n/g, '\n')).split('\n');
    lines.forEach((l, i) => {
      if (BANNED.test(l)) offences.push(`${relative(SRC, p).replace(/\\/g, '/')}:${i + 1} ${l.trim()}`);
    });
  }
  check('no per-minute figure can reach a screen', offences, []);
}

console.log('\n7. WHAT IS SHOWN IS MEASURED, and only measured');
{
  // Bytes off the file, seconds off the player. Two facts, both read from the thing
  // itself, and no third number derived from dividing one by the other.
  // The spike's 240fps 3s clip, to the digit: 12.5 MB over 2.8583s of footage.
  const d = describeClip(12.5 * MB, 2.8583);
  truthy('the size is there', /12\.5 MB/.test(d));
  truthy('and the duration', /2\.86s/.test(d));
  truthy('and nothing per-minute', !/min/i.test(d));

  // A file whose size could not be read must not report zero, which reads as a
  // clip that costs nothing.
  check('an unreadable size says so', describeClip(0, 3), 'size unreadable');
  check('and so does a negative one', describeClip(-1, 3), 'size unreadable');
  // A size without a duration is still worth stating on its own.
  check('no duration yet leaves the size alone', describeClip(5 * MB, 0), '5.0 MB');
}

console.log('\n8. formatBytes still rounds the way the delete points expect');
{
  // Moved out of clips.ts so the refusals above could use it without dragging in
  // the filesystem. Same behaviour, asserted here because five screens read it.
  check('bytes', formatBytes(512), '512 B');
  check('kilobytes round whole', formatBytes(2048), '2 KB');
  check('megabytes keep one decimal under 100', formatBytes(7.3 * MB), '7.3 MB');
  check('and lose it above', formatBytes(250 * MB), '250 MB');
}

console.log('\n9. BOTH BOUNDS REACH THE RECORDER, and no clock is invented');
{
  // storage.ts can only bound a recording if the numbers are actually handed over.
  // Read as text for the same reason as block 6: this checks the call site exists,
  // not what the arithmetic returns.
  const HERE2 = fileURLToPath(new URL('.', import.meta.url));
  // Normalised for the same reason as verify-capture's reader: a CRLF checkout
  // must not turn a guard into a pattern that quietly never matches.
  const rec = readFileSync(join(HERE2, '..', 'src', 'screens', 'VideoRecordModal.tsx'), 'utf8').replace(
    /\r\n/g,
    '\n',
  );

  // NAMED SITES, not a count. This was 'appears at least twice', which the removal
  // of the on-press re-read survived: the sheet-open check and the initial state
  // still made two. A count answers 'how many' when the question is 'which'.
  truthy('space is checked when the sheet opens', /if \(visible\) setSpace\(budgetForRecording\(freeDiskBytes\(\)\)\);/.test(rec));
  truthy('and re-read on the press, because it is only true for an instant', /const now = budgetForRecording\(freeDiskBytes\(\)\);/.test(rec));
  truthy('with the press using that fresh answer', /if \(!now\.ok\)/.test(rec));
  truthy('the duration cap is the recorder\'s, in seconds', /maxDuration: MAX_CLIP_MS \/ 1000/.test(rec));
  truthy('the byte ceiling is the recorder\'s too', /maxFileSize: now\.budgetBytes/.test(rec));
  // Omitted rather than guessed when the phone will not say how much is free. A
  // zero here would be a ceiling of nothing, which stops the recording instantly.
  truthy('and is omitted when free space is unreadable', /now\.budgetBytes !== null \?/.test(rec));

  // NO CLOCK OF OUR OWN. Every number shown during a recording is read from the
  // recorder, because a JS timer and the encoder disagree the moment the phone is
  // busy — and it is the encoder that decides when the cap fires. A screen counting
  // its own seconds would show a coach 29.4s while the file was already closed.
  truthy('elapsed is read from the recorder', /rec\.recordedDuration/.test(rec));
  truthy('and so is the size', /rec\.recordedFileSize/.test(rec));
  check('nothing on this screen counts time itself', /Date\.now\(\)/.test(rec), false);

  // WHICH THE MIS-TAP GUARD OBEYS TOO, and it is the place where a JS clock would
  // have been most expensive: this one decides whether a file is deleted, so a timer
  // disagreeing with the encoder would delete real footage. Read at the press rather
  // than polled, so it carries no tick lag — a 600ms recording cannot read as 400.
  truthy('the tap guard reads the recorder, at the press',
    /const d = rec\.recordedDuration;/.test(rec));
  // Number.isFinite, not a null check. A missing Nitro getter hands back
  // `undefined`, which is not null — it sailed past the null test and became NaN
  // one multiplication later, and NaN fails every comparison, so the clip was kept
  // and nothing recorded that the length had never been read. The guard was a no-op
  // that looked like a guard, which is exactly how it was reported from device.
  truthy('and treats an unreadable value as unreadable',
    /stoppedAtSeconds\.current = Number\.isFinite\(d\) \? d : null;/.test(rec));
  // Logged, because 'kept' has three causes that look identical from outside: long
  // enough, unreadable, or the recorder's elapsed time disagreeing with the file's.
  truthy('and says which value it read', /stop pressed, recorder says/.test(rec));
  truthy('and which way the decision went', /discarded as a tap/.test(rec));

  // A NATIVE RECORDER MUST NOT BE MERELY FORGOTTEN. Same class as the crash this
  // screen already carries a fix for: an object created and dropped for the GC to
  // find on whichever thread it runs on.
  //
  // The re-entrancy guard has to be a REF, because `recording` is state set after
  // `await createRecorder(...)` — two presses inside that window both pass a state
  // guard, the second overwrites recorder.current, and the first is never stopped,
  // never cancelled and never referenced again.
  truthy('a second press cannot start a second recorder',
    /if \(recording \|\| starting\.current \|\| !videoOutput/.test(rec));
  truthy('with the guard taken before the first await',
    /starting\.current = true;[\s\S]{0,400}createRecorder/.test(rec));
  truthy('and released however it ends', /finally \{[\s\S]{0,60}starting\.current = false;/.test(rec));

  // createRecorder can SUCCEED and startRecording still throw. Setting the ref to
  // null then leaves a live native recorder with nothing pointing at it, so the
  // handle is held outside the try and cancelled on the way out.
  truthy('the recorder is held where a failure can reach it', /let rec: Recorder \| null = null;/.test(rec));
  // ANCHORED ON THIS PATH'S OWN LINE. The first version matched `if (rec) {` plus a
  // cancelRecording within 200 characters, which the INTERRUPTION path already
  // satisfies — so it passed while the failure path forgot the recorder entirely.
  // A mutation removing the cancel survived it, which is how it was found.
  truthy('and is cancelled when the start throws',
    /start failed after createRecorder[\s\S]{0,120}rec\.cancelRecording\(\)/.test(rec));
  truthy('and when the recorder reports a failure',
    /dead\?\.cancelRecording\(\)/.test(rec));

  // ONE LINE PER RECORDER, so a run of createRecorder calls with no counterpart is
  // visible in the log instead of needing the source to be read.
  truthy('every recorder logs its release', /recorder released \(\$\{reason\}\)/.test(rec));
  truthy('and gates on that, not on a clock',
    /misTapNote\(stoppedAt \* 1000, reason\)/.test(rec));
  // A LENGTH THAT COULD NOT BE READ KEEPS THE CLIP. The default on a path that
  // deletes without asking has to be the safe one.
  truthy('an unreadable length keeps the clip', /stoppedAt === null \? null :/.test(rec));
  // BEFORE the clip is claimed, or the row exists and the file is only then removed.
  // GATED ON THE VERDICT, and ordered before the claim. Asserting only the text
  // ORDER was too weak: replacing `if (tap)` with `if (false)` left the order intact
  // and the guard passed while the branch was dead.
  truthy('and the tap is discarded before anything claims it',
    /if \(tap\) \{[\s\S]{0,80}discardRecording\(id\);[\s\S]{0,300}const clip = claimRecording/.test(rec));
  truthy('saying why, never silently', /Alert\.alert\('Nothing recorded', tap\)/.test(rec));

  // The final size comes off the FILE, never off the recorder, which reports 0 once
  // it has stopped.
  truthy('the finished clip is claimed from disk', /claimRecording\(id\)/.test(rec));
}

console.log('\nA TAP IS NOT A REP');
{
  // Reported from device: pressing record and stop in the same movement produces a
  // clip of a couple of hundred milliseconds. It cannot hold a start crossing and a
  // finish crossing, so it costs a file, a clip-list row, and a trip to a marking
  // screen that cannot produce a time from it.
  truthy('a tap is discarded, with words', !!misTapNote(200, 'stopped'));
  check('a real rep is kept', misTapNote(1500, 'stopped'), null);

  // THE BOUNDARY, both sides, because a threshold asserted only from far away is a
  // threshold that can move without failing anything.
  truthy('just under the floor is a tap', !!misTapNote(MIN_CLIP_MS - 1, 'stopped'));
  check('exactly at the floor is a recording', misTapNote(MIN_CLIP_MS, 'stopped'), null);
  check('and the floor is half a second', MIN_CLIP_MS, 500);

  // ONLY WHEN THE FINGER ENDED IT. A recording stopped by the duration cap or the
  // space cap is not a tap, and calling it one would claim a cause known to be wrong.
  // Those keep their clip and get endedBecause's explanation instead.
  check('a duration cap is never a tap', misTapNote(200, 'max-duration-reached'), null);
  check('nor is a space cap', misTapNote(200, 'max-file-size-reached'), null);
  truthy('and those still explain themselves', !!endedBecause('max-duration-reached'));

  // THE WORDS MATTER, because this deletes without asking. A file vanishing in
  // silence is the version of this worth complaining about, so the predicate and the
  // message are one function and there is no way to discard without saying why.
  const note = misTapNote(200, 'stopped');
  truthy('it says nothing was kept', /nothing was kept/.test(note));
  truthy('and says what to do instead', /press stop/i.test(note));
}

console.log('\n=============================');
console.log(
  failures === 0
    ? 'RESULT: OK — the disk is bounded by what it measures, not by what we guess.'
    : `RESULT: ${failures} FAILURE(S)`,
);
process.exit(failures === 0 ? 0 : 1);
