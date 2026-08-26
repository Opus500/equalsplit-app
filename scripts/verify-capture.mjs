// Prove the capture rule before a camera can hand back a plausible wrong number.
//
//   node scripts/verify-capture.mjs
//
// Imports src/video/capture.ts directly. Zero dependencies.
//
// THE CLAIM THAT MATTERS: a camera that silently negotiates down does not produce
// an error. It produces a time that is eight times too fast, charted as a personal
// best, and indistinguishable afterwards from a real one. Every assertion here
// exists to make that impossible to ship rather than merely unlikely.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CAPTURE_RATES,
  DEFAULT_FPS,
  FPS_TOLERANCE,
  acceptCapture,
  acceptRecording,
  acceptSession,
} from '../src/video/capture.ts';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');

/**
 * Read a source file with its line endings NORMALISED.
 *
 * git checks these files out with CRLF on Windows, so any pattern spanning a line
 * break silently stops matching — and a text guard that stops matching does not
 * fail loudly, it passes vacuously. Which is the failure mode these blocks exist to
 * prevent, arriving by the back door.
 */
const read = (abs) => readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');

/**
 * The same file with COMMENTS REMOVED, for structural claims.
 *
 * A note explaining "this is not a Modal" contains the very string that would
 * prove it still is one. Two assertions failed on their own prose the moment they
 * were written — a guard has to look at what RUNS, not at what the file says about
 * itself. Same lesson as the CRLF normalisation above, from the other direction.
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

console.log('\n1. THE DEFAULT IS 120, and that is an argument not a preference');
{
  // +/-3.4ms at 120 against a ~37ms body-part bias is 11x inside an error we
  // cannot remove. 240 halves the quantisation and buys nothing usable for twice
  // the frames. The constant is asserted so lifting it to 240 has to be deliberate.
  check('default is 120', DEFAULT_FPS, 120);
  truthy('and it is an offered rate', CAPTURE_RATES.includes(DEFAULT_FPS));
  check('rates run slowest first', [...CAPTURE_RATES], [30, 60, 120, 240]);
  check('tolerance is ten per cent', FPS_TOLERANCE, 0.1);
}

console.log('\n2. LAYER 1 — the hardware has to claim it');
{
  const no = acceptSession(240, false, 240);
  check('a device that does not offer the rate is refused', no.ok, false);
  truthy('and told what to do instead', /lower rate/i.test(no.reason));
  // Even a session claiming success cannot rescue it: if the device does not have
  // the rate, whatever the session reports is about something else.
  check('the refusal stands even when the session agrees', acceptSession(240, false, 240).ok, false);
}

console.log('\n3. LAYER 2 — the session has to have RESOLVED to it');
{
  check('a held constraint passes', acceptSession(240, true, 240).ok, true);
  check('239.467 is still 240', acceptSession(240, true, 239.467).ok, true);

  // THE NEGOTIATED FALLBACK. This is the case the whole file exists for.
  const down = acceptSession(240, true, 30);
  check('a silent drop to 30 is refused', down.ok, false);
  truthy('naming both numbers', /240/.test(down.reason) && /30/.test(down.reason));
  truthy('and saying what the harm is', /looks\s+right and is not/i.test(down.reason));
  check('a drop to 120 is refused too', acceptSession(240, true, 120).ok, false);

  // SILENCE IS NOT CONSENT. A session that reports nothing has not agreed to
  // anything, and treating undefined as "probably fine" is how the failure ships.
  check('undefined is refused', acceptSession(240, true, undefined).ok, false);
  check('null is refused', acceptSession(240, true, null).ok, false);
  truthy('as not knowing, rather than as a fallback', /did not report/i.test(acceptSession(240, true, null).reason));
}

console.log('\n4. LAYER 3 — the FILE overrules both');
{
  // The spike measured a session reporting 240 and holding it. It could equally
  // have reported 240 and written 30, and only the frames would have said so.
  const lied = acceptRecording(240, 240, 30);
  check('a file that measures 30 is refused even though the session said 240', lied.ok, false);
  truthy('the message names the measured rate', /30\.0fps/.test(lied.reason));
  truthy('and what the session had claimed', /reported 240/.test(lied.reason));
  truthy('and that the footage survives', /kept as review footage/i.test(lied.reason));

  check('a file that measures what was asked passes', acceptRecording(240, 240, 239.8).ok, true);
  check('and reports the MEASURED rate, not the requested one', acceptRecording(240, 240, 239.8).fps, 239.8);

  // A NULL MEASUREMENT IS NOT A PASS. Too few frames to measure means the clip
  // could not be read, and a clip that cannot be read cannot be timed. Defaulting
  // to "probably fine" here would undo all three layers at once.
  check('an unreadable file is refused', acceptRecording(120, 120, null).ok, false);
  check('and so is a zero rate', acceptRecording(120, 120, 0).ok, false);
  truthy('said as unknown rather than as wrong', /unknown/i.test(acceptRecording(120, 120, null).reason));
  truthy('with the video kept', /video is kept/i.test(acceptRecording(120, 120, null).reason));
}

console.log('\n5. ALL THREE, in the order they happen');
{
  check('everything agrees', acceptCapture(120, true, 120, 119.95).ok, true);
  check('and the file is what is reported back', acceptCapture(120, true, 120, 119.95).fps, 119.95);

  // ORDER MATTERS: the session is checked BEFORE recording, so a device that
  // cannot do the rate must fail without ever reaching the file check.
  const early = acceptCapture(240, false, null, null);
  check('a bad device fails at layer 1', early.ok, false);
  truthy('with layer 1 wording, not layer 3', /does not offer/i.test(early.reason));

  // And the last layer still bites when the first two are clean — which is the
  // whole reason there are three.
  const late = acceptCapture(240, true, 240, 120);
  check('clean session, lying file, still refused', late.ok, false);
  truthy('with layer 3 wording', /measures 120\.0fps/.test(late.reason));
}

console.log('\n6. THE TOLERANCE holds at both edges');
{
  // Exactly on the boundary passes; a hair beyond does not. Stated at 30fps as
  // well, because a tolerance expressed as a FRACTION has to scale with the rate
  // or it silently gets stricter as the numbers get bigger.
  check('240 +10% exactly', acceptSession(240, true, 264).ok, true);
  check('240 -10% exactly', acceptSession(240, true, 216).ok, true);
  check('just beyond is refused', acceptSession(240, true, 264.1).ok, false);
  check('30 +10% exactly', acceptSession(30, true, 33).ok, true);
  check('30 just beyond is refused', acceptSession(30, true, 33.1).ok, false);
}

console.log('\n7. THE RULE IS APPLIED WHERE IT HAS TO BE');
{
  // A pure rule with no caller is a rule that ships nothing. These read the two
  // screens as text, because what is being checked is that the call EXISTS at the
  // right moment — not what it returns, which blocks 2 to 6 already settle.
  //
  // Each layer is asserted at the only place it can bite, and the places differ on
  // purpose: 1 and 2 before the rep is run, 3 after the frames exist.
  const at = (rel) => read(join(SRC, rel));

  const rec = at('screens/VideoRecordModal.tsx');
  truthy('the camera screen asks acceptSession', /acceptSession\(target, device\.supportsFPS\(target\), settledFps\)/.test(rec));
  truthy('and refuses rather than warning', /if \(!verdict\.ok\)[\s\S]{0,120}return;/.test(rec));
  truthy('before any recorder is created', rec.indexOf('acceptSession(') < rec.indexOf('createRecorder('));

  // THE STALE-SESSION TRAP. Changing the rate renegotiates the session, and until it
  // reports again the previous answer describes a different configuration. Pairing
  // the report with the target it was made for is what turns a stale agreement into
  // no agreement, which acceptSession already refuses.
  truthy('a session report is stored with the rate it was made for', /forFps: target/.test(rec));
  truthy('and a report for another rate reads as no report', /session\.forFps === target \? session\.fps : null/.test(rec));

  // A recorded clip is 'recorded', never 'unknown'. The two mean opposite things:
  // one is "there was nothing to ask", the other is "we could not ask".
  truthy("a recording reports itself as recorded", /timeScale: 'recorded'/.test(rec));

  // A PHONE CALL IS THE ORDINARY CASE. iOS takes the camera for a call, for Control
  // Centre, or when the app is backgrounded mid-rep, and none of it was handled: the
  // session went away, the recorder was left believing it was running, and the coach
  // got no explanation for a rep that did not save.
  truthy('an interruption stops the recording', /onInterruptionStarted=/.test(rec));
  truthy('and so does leaving the app', /AppState\.addEventListener\('change'/.test(rec));
  truthy('with what was filmed KEPT, not discarded', /stopBecauseInterrupted/.test(rec) && /is kept and can be marked/.test(rec));
  // Leaving the Video tab unmounts the whole tree; a native recorder must not
  // outlive the screen that knows the id of the file it is writing.
  truthy('and an unmount cancels rather than orphaning bytes', /screen unmounted while recording/.test(rec));

  // A HARD DENIAL CANNOT BE UNDONE BY ASKING AGAIN — requestPermission resolves
  // false without showing anything, so a button that only calls it is a dead end.
  truthy('a refused camera offers Settings', /Linking\.openSettings\(\)/.test(rec));

  // THE CAMERA MUST NOT BECOME GARBAGE. Two crash reports, one backtrace: Hermes's
  // background GC thread ("hades") swept a dead NativeState, which ran
  // HybridCameraSession.deinit, which called -[AVCaptureSession dealloc] OFF the main
  // thread, where AVFoundation's own teardown assertion aborts. React Native's Modal
  // returns null from render() when hidden, so every close of this sheet unmounted
  // <Camera> and left a live capture session for the collector to find.
  const recCode = code(join(SRC, 'screens', 'VideoRecordModal.tsx'));
  check('the sheet is not a Modal', /<Modal/.test(recCode), false);
  truthy('it is an always-mounted overlay', /style=\{\[styles\.overlay, !visible && styles\.hidden\]\}/.test(recCode));
  truthy('with the camera inside that overlay', recCode.indexOf('styles.overlay') < recCode.indexOf('<Camera'));
  truthy('and only the SESSION stopped', /isActive=\{visible\}/.test(recCode));

  const mark = at('screens/VideoMarkScreen.tsx');
  truthy('the marking screen runs layer 3', /acceptRecording\(capture\.requestedFps, capture\.selectedFps, measured\)/.test(mark));
  truthy('against the MEASURED rate, not a nominal one', !/acceptRecording\([^)]*nominal/i.test(mark));
  // AND ONLY WHEN THE RATE WAS READABLE. A probe seeded at the 30fps fallback can
  // only ever find every Nth frame, so measuredFps would be measuring the guess and
  // layer 3 would refuse a good recording and blame the camera. Passing null makes
  // acceptRecording say the true thing: the file could not be read back.
  truthy('and never against a measurement taken on a guessed grid', /const measured = tracked \? measuredFps\(g\) : null;/.test(mark));
  truthy('and a refusal is remembered rather than only alerted', /setRefused\(v\.reason\)/.test(mark));
  // THE REFUSAL HAS TO BITE. An alert the coach dismisses, with Keep still live
  // underneath it, is not a refusal — it is a message.
  truthy('Keep is disabled while a time is refused', /disabled=\{!timing \|\| !!keepBlocked\}/.test(mark));
  // keepBlocked, not refused: a refusal is only ONE of the reasons Keep can be off,
  // and the others used to show nothing at all. See whyNotTimeable.
  truthy('and a refusal is one of the reasons it reports', /refused \?\?/.test(mark));
  truthy('and the reason stays on screen beside it', /\{keepBlocked\}/.test(mark));

  // "NOT YET" IS NOT "CANNOT". whyNotTimeable describes a STATE, and the marks are
  // recomputed on every drag frame against a grid not yet probed there — so before
  // this suppression the honest message fired continuously during every ordinary
  // drag, telling the coach to fix something about to fix itself.
  truthy('the state message waits for resolution to be tried', /dragging \|\| settling/.test(mark));
  // But a verdict and a failed attempt are not states, and must survive a drag.
  truthy('while a layer 3 refusal is never suppressed', /refused \?\?[\s\S]{0,40}settleNote \?\?/.test(mark));
  // WIDEN, NOT SNAP: the settle measures the missing successor rather than moving
  // the coach's mark to a frame that already has one.
  truthy('and the settle widens rather than merely probing', /probeToResolve\(player, live\.current\.grid/.test(mark));

  // ONE LOCK OVER THE PLAYER. A crash report showed an Expo Modules promise being
  // destroyed with a null dereference while this screen could have up to eighteen
  // thumbnail promises outstanding AND a replaceAsync swapping the source underneath
  // them. loadingClip guarded load-against-load; nothing guarded load-against-settle
  // or settle-against-step, and those share the player and the grid.
  truthy('a single lock serialises player work', /const playerLock = useRef<Promise<unknown>>/.test(mark));
  // THE QUEUEING ITSELF, not the scaffolding around it. Asserting the declaration
  // and the tail assignment left a mutation alive that replaced the body with a bare
  // fn() call — lock present, nothing serialised.
  truthy('work is chained onto the previous run', /const run = playerLock\.current\.then\(fn, fn\);/.test(mark));
  truthy('the chain cannot inherit a rejection', /playerLock\.current = run\.then\(/.test(mark));
  truthy('loading a clip takes it', /withPlayer\(async \(\) => \{/.test(mark));
  truthy('settling takes it', /return await withPlayer\(async \(\) => \{/.test(mark));
  truthy('and stepping takes it', /withPlayer\(\(\) => probeToResolve\(player, g, at, fd\)\)/.test(mark));
  // The footage survives either way; only the time was refused.
  truthy('with a way out that asks before deleting', /Keep the video\?/.test(mark));
}

// Block 8 lived here and has moved to scripts/verify-reachable.mjs, which is now the
// one place that answers "can a coach get to it". It was written here because that is
// where the gap was noticed; keeping it here would have left two homes for the same
// question, and two homes is how one of them stops being read.

console.log('\n=============================');
console.log(failures === 0 ? 'RESULT: OK — a wrong frame rate cannot become a time.' : `RESULT: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
