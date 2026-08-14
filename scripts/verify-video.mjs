// Prove the video timing layer before any of it reaches a screen.
//
//   node scripts/verify-video.mjs
//
// Written against src/video/timing.ts, which knows nothing about how frames are
// obtained. That is the point: the spike has not settled whether frame timestamps
// come from a thumbnail API, from player seeks, or from a native module, and all
// three hand back the same thing — a list of presentation timestamps. So this can
// be proved now, and the decode fight cannot invalidate it.
//
// The claims that actually matter here:
//   - a video run never shares a series with a gate run
//   - the +/- comes from the clip's MEASURED frame durations, not a constant
//   - frame stepping refuses to leave the probed region rather than guessing 1/fps

import './_ts-resolve.mjs';

const {
  VIDEO_MODE,
  runTimeSource,
  seriesTimeSource,
  seriesKey,
  timeFromMarks,
  VIDEO_DECIMALS,
  formatVideoSeconds,
  formatVideoTime,
  parallaxErrorMs,
  BODY_PART_BIAS_MS,
  emptyGrid,
  alignedProbes,
  gapProbes,
  ingestFrames,
  isCovered,
  frameIndexAt,
  markAt,
  stepFrames,
  measuredFps,
  isVariableRate,
  videoRunRawJson,
  parseVideoRunJson,
  FRAME_FAN_OUT,
  chunk,
  seekTimeFor,
  filmstripTimes,
  lastMarkableTime,
  nominalSdMs,
} = await import('../src/video/timing.ts');
const { restRepRawJson, runStartSource, REPEAT_MODE } = await import('../src/ble/repeats.ts');
// The real grouping path, imported so block 3 can check that seriesKey — which no
// app code calls — still describes what the app actually does.
const { buildProgression, seriesUid } = await import('../src/roster/progression.ts');

let failures = 0;
const check = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n         got  ${g}\n         want ${w}`}`);
};
const truthy = (label, v) => check(label, !!v, true);
const near = (label, got, want, tol) => {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n         got  ${got}\n         want ${want} +/-${tol}`}`);
};

// A constant-rate grid helper: n frames at `fps` starting at `t0`.
const cfr = (t0, fps, n) => Array.from({ length: n }, (_, i) => t0 + i / fps);

console.log('\n1. MODE 5 exists because mode encodes the PRODUCER');
{
  // A video run's row shape is a single time, same as a drill run. It still earns
  // its own mode because no gate was involved at all, and mode has always meant
  // "what made this row" rather than "how many numbers are in it".
  check('video runs are mode 5', VIDEO_MODE, 5);
  truthy('and 5 is not the rep-set mode', VIDEO_MODE !== REPEAT_MODE);
}

console.log('\n2. TIME SOURCE is read through one helper');
{
  const raw = videoRunRawJson({ startPts: 1, endPts: 5, fps: 30, quantSdMs: 13.6 });
  check('a video run reports video', runTimeSource(raw), 'video');
  check('and is marked inexact', JSON.parse(raw).exact, false);

  // Consistency with the existing rest-rep helper. A rest rep is hand-STARTED and
  // gate-finished; the hand error dominates, so it groups as hand.
  const rest = restRepRawJson({ ms: 64000, closeUs: 1, closeAtMs: 1, lockoutMs: 1000, gateId: 1 });
  check('a rest rep reports hand', runTimeSource(rest), 'hand');
  check('and repeats.ts still reads its start as a tap', runStartSource(rest), 'tap');

  // Silence is never a claim.
  check('an ordinary run says nothing', runTimeSource('{"engine":"v2"}'), null);
  check('nor does null', runTimeSource(null), null);
  check('malformed json is not a claim', runTimeSource('{not json'), null);
}

console.log('\n3. GROUPING folds unknown to gate, but the UI is never told that');
{
  // Two different calls on purpose. Every run predating the field is gate-timed,
  // so grouping folds it to gate rather than splitting every existing series in
  // half — but runTimeSource still returns null so no screen can CLAIM it.
  check('grouping folds unknown to gate', seriesTimeSource('{"engine":"v2"}'), 'gate');
  check('while the display helper stays silent', runTimeSource('{"engine":"v2"}'), null);

  const vid = videoRunRawJson({ startPts: 0, endPts: 4, fps: 30, quantSdMs: 13.6 });
  truthy(
    'a video run and a gate run of the SAME drill never share a key',
    seriesKey('d1', seriesTimeSource(vid)) !== seriesKey('d1', seriesTimeSource(null)),
  );
  check('the same drill and source do share one', seriesKey('d1', 'video'), seriesKey('d1', 'video'));
  truthy('and two drills never share one', seriesKey('d1', 'gate') !== seriesKey('d2', 'gate'));

  // TIED TO THE REAL GROUPING PATH, because seriesKey has no caller in the app:
  // progression.ts builds the same key inline, since it must stay import-free. So
  // everything above proved a rule against a COPY, and a change to either side
  // would have left this block cheerfully proving a rule the app no longer
  // followed. These two assertions are what make the copy provably in step.
  const p = buildProgression([
    { id: 'g', drillId: 'd1', drillName: '30m', elapsedMs: 4200, createdAt: 1, timeSource: 'gate' },
    { id: 'v', drillId: 'd1', drillName: '30m', elapsedMs: 4400, createdAt: 2, timeSource: 'video' },
  ]);
  check('the app really does split one drill by source', p.series.length, 2);
  check(
    'and seriesKey predicts exactly the keys it grouped by',
    p.series.map(seriesUid).sort(),
    [seriesKey('d1', 'gate'), seriesKey('d1', 'video')].sort(),
  );
}

console.log('\n4. TWO MARKS to an elapsed time');
{
  const d30 = 1 / 30;
  const a = { pts: 1.0, frameDurSec: d30 };
  const b = { pts: 5.0, frameDurSec: d30 };
  const t = timeFromMarks(a, b);
  near('elapsed is the difference of the timestamps', t.elapsedMs, 4000, 1e-6);

  // The bias cancels. Both marks are the first frame AFTER the crossing, so both
  // are late — and the difference of two same-signed biases is ~0, not one frame.
  // That is why the figure below is a spread and not an offset.
  near('1 sigma at 30fps is ~13.6ms, not half a frame', t.quantSdMs, 13.6, 0.2);
  near('worst single-sided error is one frame', t.quantWorstMs, 33.333, 0.01);

  // Inverted marks are an input error, not a measurement to warn about.
  check('marks out of order are refused', timeFromMarks(b, a), null);
  check('equal marks are refused', timeFromMarks(a, a), null);
  check('a non-finite mark is refused', timeFromMarks({ pts: NaN, frameDurSec: d30 }, b), null);
}

console.log('\n5. THE +/- COMES FROM THE CLIP, not a constant');
{
  const sd = (fps) => timeFromMarks({ pts: 0, frameDurSec: 1 / fps }, { pts: 2, frameDurSec: 1 / fps }).quantSdMs;
  near('30fps', sd(30), 13.61, 0.05);
  near('60fps', sd(60), 6.8, 0.05);
  near('240fps  — 8x better than 30, and it should be allowed to say so', sd(240), 1.7, 0.05);
  truthy('a faster clip is strictly better', sd(240) < sd(60) && sd(60) < sd(30));

  // Variable frame rate: the two marks can sit on frames of DIFFERENT lengths,
  // which is precisely why this takes durations rather than one fps number.
  const mixed = timeFromMarks({ pts: 0, frameDurSec: 1 / 30 }, { pts: 2, frameDurSec: 1 / 240 });
  truthy('a mixed-rate pair lands between the two', mixed.quantSdMs < sd(30) && mixed.quantSdMs > sd(240));

  // Display shows two decimals ALWAYS, with the uncertainty beside it. Rounding a
  // 30fps time to 4.2s was arithmetically defensible and practically worse: a
  // tenth is too coarse to read, and rounding HIDES the uncertainty instead of
  // stating it. The +/- is what licenses the second digit.
  check('two decimals, whatever the frame rate', VIDEO_DECIMALS, 2);
  // DERIVED from the constant, not restating '4.21'. The decimals are a product
  // decision that has already moved once (fps-dependent -> always two), and a test
  // that hardcodes the digits starts asserting the old policy the day it changes.
  check('the digits follow the constant', formatVideoSeconds(4213), (4.213).toFixed(VIDEO_DECIMALS));

  const slow = timeFromMarks({ pts: 0, frameDurSec: 1 / 30 }, { pts: 4.213, frameDurSec: 1 / 30 });
  const fast = timeFromMarks({ pts: 0, frameDurSec: 1 / 240 }, { pts: 4.213, frameDurSec: 1 / 240 });
  check('the same digits, but the honesty rides alongside', formatVideoTime(slow), '4.21s ± 14ms');
  check('and a faster clip says a smaller number', formatVideoTime(fast), '4.21s ± 2ms');

  // THE CLAIM THE OLD DUPLICATE WAS TRYING TO MAKE. It read "and so does a 240fps
  // one" while calling formatVideoSeconds(4213) a second time — byte-identical to
  // the line above, with no frame rate anywhere in it, so it passed under every
  // possible implementation including the fps-dependent one it was written to
  // outlaw. Splitting the rendered string is what actually tests it: the seconds
  // must be identical across a 30fps and a 240fps clip, and ONLY the +/- may differ.
  const [slowSec, slowPm] = formatVideoTime(slow).split(' ± ');
  const [fastSec, fastPm] = formatVideoTime(fast).split(' ± ');
  check('30fps and 240fps print the SAME seconds', slowSec, fastSec);
  truthy('and differ only in the uncertainty', slowPm !== fastPm);
  truthy('so the two are distinguishable where it matters', formatVideoTime(slow) !== formatVideoTime(fast));
}

console.log('\n6. THE ERRORS THAT DO NOT SHRINK are kept out of the computed figure');
{
  // Body-part judgement is a BIAS, not noise: it does not average out over a
  // season, and it is the real reason gate and video runs must not mix.
  near('0.3m of body extent at 8m/s', BODY_PART_BIAS_MS, 37, 1);

  // Parallax is the term the coach can actually act on, so it is a function of
  // their setup rather than a constant.
  near('perpendicular camera has no parallax', parallaxErrorMs(0, 1, 8), 0, 1e-9);
  near('10 degrees off, 1m wide, 8m/s', parallaxErrorMs(10, 1, 8), 22, 1);
  near('20 degrees is worse than 10', parallaxErrorMs(20, 1, 8), 45.5, 1);
  truthy('and standing closer to the reference helps', parallaxErrorMs(10, 0.5, 8) < parallaxErrorMs(10, 1, 8));

  // Neither is folded into quantSdMs — a computed number must not carry estimates.
  const t = timeFromMarks({ pts: 0, frameDurSec: 1 / 30 }, { pts: 2, frameDurSec: 1 / 30 });
  truthy('the computed sigma is quantization only', t.quantSdMs < BODY_PART_BIAS_MS);
}

console.log('\n7. LAZY GRID: clips are uncapped, so coverage is tracked');
{
  let g = emptyGrid();
  check('an empty grid covers nothing', isCovered(g, 1), false);
  check('and resolves no frame', frameIndexAt(g, 1), null);

  const { window, times } = alignedProbes(1.0, 1 / 30, 5, 5);
  truthy('probing asks around the anchor', window.from < 1.0 && window.to > 1.0);
  check('one probe per frame, not four', times.length, 11);
  // Near the start of a clip the probes before zero are DROPPED, not clamped —
  // two requests for the same time would waste a call and find one frame.
  const nearZero = alignedProbes(0.01, 1 / 30, 5, 5);
  check('and never a negative time', nearZero.times.every((t) => t > 0), true);
  // `every` is true of an empty array, so the count has to be pinned too or
  // "returns nothing at all" would pass the line above. 0.01s in at 30fps: k=-5..-1
  // land at or below zero and go, k=0..5 survive.
  check('by dropping only the probes that fell off the front', nearZero.times.length, 6);
  near('the window never starts before zero', nearZero.window.from, 0, 1e-9);

  g = ingestFrames(g, window, cfr(0.8, 30, 12));
  check('now covered at the centre', isCovered(g, 1.0), true);
  check('but not far away', isCovered(g, 8.0), false);
  check('and an uncovered time resolves to nothing', frameIndexAt(g, 8.0), null);

  // Duplicate probes must not duplicate frames — four requests land in each frame.
  const before = g.frames.length;
  g = ingestFrames(g, window, cfr(0.8, 30, 12));
  check('re-ingesting the same frames adds none', g.frames.length, before);
}

console.log('\n8. STEPPING refuses to guess past what it has measured');
{
  let g = ingestFrames(emptyGrid(), { from: 1.0, to: 1.4 }, cfr(1.0, 30, 13));

  const m = markAt(g, 1.05);
  near('a mark lands on the frame being displayed', m.pts, 1.0 + 1 / 30, 1e-9);
  near('and carries that frame’s own duration', m.frameDurSec, 1 / 30, 1e-9);

  near('stepping forward one frame', stepFrames(g, 1.05, 1).pts, 1.0 + 2 / 30, 1e-9);
  near('and back one', stepFrames(g, 1.05, -1).pts, 1.0, 1e-9);

  // THE INVARIANT. The last known frame has no measured successor, so its duration
  // is unknown — resolving it anyway would let a caller compute an error bar from
  // a frame length it never measured.
  check('the last known frame does not resolve', frameIndexAt(g, 1.0 + 12 / 30), null);
  check('stepping off the end refuses', stepFrames(g, 1.05, 50), null);
  check('and off the start refuses', stepFrames(g, 1.05, -50), null);

  // Extrapolating by 1/fps is exactly what drifts on VFR, which is why it is not
  // done: past the probed region the answer is "probe more", not a guess.
  check('beyond coverage there is no answer', markAt(g, 5.0), null);
}

console.log('\n9. VARIABLE FRAME RATE is detected, not assumed away');
{
  const even = ingestFrames(emptyGrid(), { from: 0, to: 1 }, cfr(0, 30, 20));
  check('an even clip is not flagged', isVariableRate(even), false);
  near('and its measured rate is its real rate', measuredFps(even), 30, 0.001);

  // A dropped frame in the middle — what low light does to an iPhone recording.
  const uneven = ingestFrames(emptyGrid(), { from: 0, to: 1 }, [
    ...cfr(0, 30, 6),
    ...cfr(6 / 30 + 1 / 15, 30, 6),
  ]);
  check('an uneven clip is flagged', isVariableRate(uneven), true);
  truthy('and its measured rate is below nominal', measuredFps(uneven) < 30);

  check('too few frames to judge', measuredFps(emptyGrid()), null);
  check('and no false VFR claim from them', isVariableRate(emptyGrid()), false);
}

console.log('\n10. THE ROW carries its own accuracy');
{
  const raw = videoRunRawJson({ startPts: 1.5, endPts: 5.75, fps: 59.94, quantSdMs: 6.8 });
  const back = parseVideoRunJson(raw);
  near('start survives', back.startPts, 1.5, 1e-9);
  near('end survives', back.endPts, 5.75, 1e-9);
  near('the MEASURED fps survives, not a nominal one', back.fps, 59.94, 1e-9);
  near('and so does the error bar', back.quantSdMs, 6.8, 1e-9);

  // THE SEPARATION. raw_json answers "how was this timed"; runs.clip_id answers
  // "is there footage". If the clip lived here, attaching review video to a GATE
  // run would have to write this JSON over the gate's — flipping timeSource to
  // 'video' and moving the run into a different progression series. A review clip
  // would silently reclassify a gate-timed run as video-timed.
  check('raw_json carries no clip reference', 'clipId' in JSON.parse(raw), false);
  check(
    'nor any other clip-shaped key',
    Object.keys(JSON.parse(raw)).some((k) => /clip/i.test(k)),
    false,
  );
  // WHAT THIS FILE CANNOT PROVE, said plainly rather than implied by a label. The
  // second assertion here used to read "so attaching footage cannot change how a
  // run was timed" while re-checking a property already proved in block 2 — the
  // label claimed the whole rule and the code checked none of it. The real claim
  // is that setRunClip writes clip_id and nothing else, which is a SQL statement
  // in database.ts with no pure surface to test from here. It is unproven by any
  // script; see test 2 of the device plan.

  // It must not claim rows that are not video runs.
  check('a rep set is not a video run', parseVideoRunJson('{"engine":"rep-set"}'), null);
  check('nor is a rest rep', parseVideoRunJson(restRepRawJson({ ms: 1, closeUs: 1, closeAtMs: 1, lockoutMs: 1, gateId: 1 })), null);
  check('nor malformed json', parseVideoRunJson('{nope'), null);
}

console.log('\n11. PROBING is ANCHORED, so it costs one call per frame');
{
  // Measured on device: 30 requests spaced exactly 1/fps apart came back with only
  // 29 distinct frames. Zero-tolerance extraction returns the frame CONTAINING the
  // requested time, so a request on a boundary is decided by float representation
  // — one floored to the frame before.
  //
  // The fix is to aim rather than oversample. Probing blind needed four calls per
  // frame to be sure of hitting each one; anchoring to a REAL timestamp makes the
  // grid's phase known, so every probe can sit half a frame past a true boundary.
  // For a 24-frame window that is 96 calls against 25 — on device, ~730ms against
  // ~130ms, paid on every step and every drag release.
  const dur = 1 / 30;
  const anchor = 2.0;
  const { times } = alignedProbes(anchor, dur, 5, 5);
  const offEdge = times.every((t) => {
    const frac = ((((t - anchor) / dur) % 1) + 1) % 1;
    return Math.min(frac, 1 - frac) > 0.4; // half a frame from either boundary
  });
  truthy('every probe sits mid-frame relative to the anchor', offEdge);
  check('and there is exactly one per frame', times.length, 11);

  // The same rule for stepping: to display frame N, ask for its middle.
  const m = { pts: 2.0, frameDurSec: dur };
  near('a seek target is half a frame in', seekTimeFor(m), 2.0 + dur / 2, 1e-9);
  truthy('which is strictly inside the frame', seekTimeFor(m) > m.pts && seekTimeFor(m) < m.pts + dur);

  // Round trip: seeking to the computed time must resolve back to the same frame.
  const g = ingestFrames(emptyGrid(), { from: 1.9, to: 2.2 }, [1.95, 2.0, 2.0 + dur, 2.0 + 2 * dur]);
  check('the seek target resolves to the frame it came from', markAt(g, seekTimeFor(m)).pts, 2.0);
}

console.log('\n11b. GAP REPAIR is proportional to the damage');
{
  const dur = 1 / 30;
  // A constant-rate clip: aiming worked, nothing was missed, nothing to re-probe.
  const even = ingestFrames(emptyGrid(), { from: 0, to: 1 }, cfr(0, 30, 10));
  check('an even grid needs no repair', gapProbes(even, dur), []);

  // A dropped frame — what low light does to an iPhone recording, and what the
  // anchored alignment drifts past on a variable-rate clip.
  const holed = ingestFrames(emptyGrid(), { from: 0, to: 1 }, [
    0, dur, 2 * dur, /* 3*dur missing */ 4 * dur, 5 * dur,
  ]);
  const holes = gapProbes(holed, dur);
  check('exactly one hole is found', holes.length, 1);
  near('and it is probed in the middle of the gap', holes[0], 3 * dur, 1e-9);

  // The repair must not fire on ordinary spacing jitter, or every probe would
  // trigger a second round for nothing.
  const jittery = ingestFrames(emptyGrid(), { from: 0, to: 1 }, [0, dur * 1.05, dur * 2.1, dur * 3.15]);
  check('normal jitter is not mistaken for a hole', gapProbes(jittery, dur), []);

  // BRACKETED, so the 1.5-frame threshold is actually pinned. The jitter case
  // above sits at 1.05 frames, which any threshold from ~1.1 upwards would pass —
  // it proves the repair is not trigger-happy, not where the line is drawn.
  const gapOf = (mult) => gapProbes(ingestFrames(emptyGrid(), { from: 0, to: 1 }, [0, dur * mult]), dur);
  check('a gap just under 1.5 frames is left alone', gapOf(1.49), []);
  check('and one just over it is repaired', gapOf(1.51).length, 1);
}

console.log('\n11c. A MARK CAN NEVER LAND ON THE LAST FRAME');
{
  // This is a bug that shipped twice. The last frame of a clip has no measured
  // successor, so frameIndexAt refuses it on purpose — an error bar computed from
  // an unmeasured frame length would be invented. That refusal is right, and it
  // makes any position at or past the last frame a dead end: no mark, no stepping,
  // no time, and no way back because dragging further does nothing.
  //
  // The import path backed off by 1.5 frames. The DRAG clamped to the raw duration
  // and put the handle exactly there, so a handle dragged to the right edge stuck
  // permanently. One rule, enforced in two places, right in one of them — so the
  // rule is now a function and this is the test that keeps them together.
  const dur = 1 / 30;
  const d = 10;
  const at = lastMarkableTime(d, dur);
  truthy('the bound sits strictly inside the clip', at < d);
  near('by a frame and a half', d - at, dur * 1.5, 1e-9);

  // THE PROOF, through the grid rather than by restating the arithmetic: a mark at
  // the bound resolves, and a mark at the raw duration does not.
  const frames = [];
  for (let t = d - 6 * dur; t < d; t += dur) frames.push(t);
  const g = ingestFrames(emptyGrid(), { from: d - 7 * dur, to: d + dur }, frames);
  truthy('a mark at the bound resolves to a real frame', markAt(g, at) !== null);
  truthy('and can still be stepped backwards', stepFrames(g, at, -1) !== null);
  check('while a mark at the raw duration resolves to nothing', markAt(g, d), null);
  check('which is exactly why it could not be stepped off', stepFrames(g, d, -1), null);

  // Degenerate clips must not produce a negative bound.
  check('a clip shorter than a frame clamps to zero', lastMarkableTime(0.01, dur), 0);
  check('and a zero frame duration falls back rather than dividing by nothing', lastMarkableTime(10, 0) < 10, true);
}

console.log('\n11d. THE PROVISIONAL +/- IS THE SAME CLAIM, not a placeholder');
{
  // Shown while a handle is moving, before the grid around it has been probed. It
  // has to be the SAME arithmetic as the settled figure or the number would visibly
  // jump on release for reasons that are about the code rather than the clip.
  for (const fps of [24, 30, 60, 240]) {
    const settled = timeFromMarks({ pts: 0, frameDurSec: 1 / fps }, { pts: 2, frameDurSec: 1 / fps });
    near(`${fps}fps: provisional equals settled for equal frames`, nominalSdMs(1 / fps), settled.quantSdMs, 1e-9);
  }
  truthy('a faster clip still promises less error', nominalSdMs(1 / 240) < nominalSdMs(1 / 30));
  check('and a nonsense frame duration is not NaN', nominalSdMs(-1), 0);
}

console.log('\n12. FAN-OUT batching');
{
  check('fan-out is the measured width', FRAME_FAN_OUT, 8);
  check('work splits into groups', chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  check('an exact multiple leaves no stub', chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
  check('empty stays empty', chunk([], 8), []);
  // A zero or negative width would loop forever, so it is floored to 1.
  check('a zero width cannot hang the loop', chunk([1, 2], 0), [[1], [2]]);
  check('nor a negative one', chunk([1, 2], -5), [[1], [2]]);
}

console.log('\n13. FILMSTRIP tiles');
{
  const t = filmstripTimes(0, 10, 5);
  check('one time per tile', t.length, 5);
  truthy('none at the exact start', t[0] > 0);
  truthy('and none at or past the end — the last frame is the one with nothing after it', t[4] < 10);
  // Evenly spaced, so the strip reads as a uniform index of the clip.
  const gaps = t.slice(1).map((v, i) => v - t[i]);
  truthy('evenly spaced', Math.max(...gaps) - Math.min(...gaps) < 1e-9);
  check('a degenerate range still yields something drawable', filmstripTimes(5, 5, 8).length, 1);

  // NEVER A NEGATIVE TIME, asserted over every element rather than over the first
  // one against a bound it could clear while still being negative. The old version
  // checked `filmstripTimes(-3,-1,4)[0] > -3`, which -2.75 satisfies — so the test
  // passed while the function returned exactly the thing the label forbade, and
  // only the degenerate branch was actually clamping.
  check('never a negative time, in the degenerate branch', filmstripTimes(-3, -3, 4).every((t) => t >= 0), true);
  check('nor in the ordinary one', filmstripTimes(-3, -1, 4).every((t) => t >= 0), true);
  check('and not by returning nothing', filmstripTimes(-3, -1, 4).length, 4);
  // The reachable case is unaffected: from = 0 is the only value the app passes.
  truthy('a real clip is untouched by the clamp', filmstripTimes(0, 10, 5).every((t) => t > 0 && t < 10));
}

console.log(
  failures === 0
    ? '\nRESULT: OK — video timing, series split and lazy grid rules hold.\n'
    : `\nRESULT: ${failures} FAILURE(S)\n`,
);
process.exit(failures === 0 ? 0 : 1);
