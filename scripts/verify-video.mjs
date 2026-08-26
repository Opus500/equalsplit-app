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
//   - a video run SHARES a series with a gate run and is marked on it; a
//     hand-started run does not (block 3 — this reversed, see verify-progression 15)
//   - the +/- comes from the clip's MEASURED frame durations, not a constant
//   - frame stepping refuses to leave the probed region rather than guessing 1/fps,
//     and never steps from one probed island into another (11g)

import './_ts-resolve.mjs';

const {
  VIDEO_MODE,
  runTimeSource,
  seriesTimeSource,
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
  nominalErrorMs,
  adjacentDeltas,
  acceptForTiming,
  acceptForReview,
  ceilTenth,
  coveredWindow,
  spanCovered,
  whyNotTimeable,
} = await import('../src/video/timing.ts');
const { restRepRawJson, runStartSource, REPEAT_MODE } = await import('../src/ble/repeats.ts');
// The REAL probe path. frames.ts imports expo-video for types only, so it loads
// standalone — which is what lets block 11h drive it against a fake decoder rather
// than reasoning about what it would do.
const { probeGridAround, probeToResolve, resolveMarks, loadClipInto } = await import('../src/video/frames.ts');
// The real grouping path — the ONLY thing that groups anything, now that
// timing.ts's callerless seriesKey() copy of the rule is gone.
const { buildProgression, seriesUid, sourceGroup } = await import('../src/roster/progression.ts');

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
  const raw = videoRunRawJson({ startPts: 1, endPts: 5, fps: 30, errorMs: 33.4 });
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

  // WHERE THE LINE IS DRAWN, read off the real grouping rule. Video joins gate
  // because the difference between them is bounded by a body — roughly a frame
  // either way. Hand does not, because human reaction time is larger than the
  // trend being plotted and has the spread to match.
  const vid = videoRunRawJson({ startPts: 0, endPts: 4, fps: 30, errorMs: 33.4 });
  const rest = restRepRawJson({ ms: 64000, closeUs: 1, closeAtMs: 1, lockoutMs: 1000, gateId: 1 });
  check('a video run groups with gate', sourceGroup(seriesTimeSource(vid)), 'timed');
  check('and so does a run that says nothing', sourceGroup(seriesTimeSource(null)), 'timed');
  check('a hand-started rep stays apart', sourceGroup(seriesTimeSource(rest)), 'hand');

  // STATED THROUGH buildProgression, not through a second copy of the key.
  // timing.ts used to export a seriesKey() with no caller in the app, so every
  // assertion about grouping here proved a rule the app was free to stop
  // following. It is deleted; buildProgression is the only thing that groups.
  const p = buildProgression([
    { id: 'g', drillId: 'd1', drillName: '30m', elapsedMs: 4200, createdAt: 1, timeSource: seriesTimeSource(null) },
    { id: 'v', drillId: 'd1', drillName: '30m', elapsedMs: 4400, createdAt: 2, timeSource: seriesTimeSource(vid) },
    { id: 'h', drillId: 'd1', drillName: '30m', elapsedMs: 4600, createdAt: 3, timeSource: seriesTimeSource(rest) },
  ]);
  check('gate and video share a page, hand takes its own', p.series.length, 2);
  check('and the keys say which is which', p.series.map(seriesUid).sort(), ['d1|hand', 'd1|timed']);

  const timed = p.series.find((s) => s.group === 'timed');
  check('the merged page names both its sources', timed.sources, ['gate', 'video']);
  check('and every point still says its own', timed.points.map((x) => x.timeSource), ['gate', 'video']);

  // Two drills never share a page. That rule is older than the source split and
  // was never subordinate to it.
  const two = buildProgression([
    { id: 'a', drillId: 'd1', drillName: '30m', elapsedMs: 4200, createdAt: 1, timeSource: 'gate' },
    { id: 'b', drillId: 'd2', drillName: '40yd', elapsedMs: 5200, createdAt: 2, timeSource: 'gate' },
  ]);
  check('two drills, two keys', new Set(two.series.map(seriesUid)).size, 2);
}

console.log('\n4. TWO MARKS to an elapsed time');
{
  const d30 = 1 / 30;
  const a = { pts: 1.0, frameDurSec: d30 };
  const b = { pts: 5.0, frameDurSec: d30 };
  const t = timeFromMarks(a, b);
  near('elapsed is the difference of the timestamps', t.elapsedMs, 4000, 1e-6);

  // A WHOLE FRAME, not a standard deviation, and the change was deliberate.
  //
  // The old figure was sqrt((da^2+db^2)/12) — the statistical spread from landing
  // anywhere within a frame. Correct in isolation, and the wrong number to show:
  // it sat beside two LARGER errors not modelled at all (parallax, and a body-part
  // bias estimated at ~37ms), so a tight +/-1.7ms claimed a precision the method
  // does not have. The worst case is defensible without a footnote.
  near('the error at 30fps is one whole frame', t.errorMs, 33.4, 0.001);
  truthy('which is larger than the spread it replaced', t.errorMs > 13.6);

  // Inverted marks are an input error, not a measurement to warn about.
  check('marks out of order are refused', timeFromMarks(b, a), null);
  check('equal marks are refused', timeFromMarks(a, a), null);
  check('a non-finite mark is refused', timeFromMarks({ pts: NaN, frameDurSec: d30 }, b), null);
}

console.log('\n5. THE +/- COMES FROM THE CLIP, not a constant');
{
  const err = (fps) => timeFromMarks({ pts: 0, frameDurSec: 1 / fps }, { pts: 2, frameDurSec: 1 / fps }).errorMs;
  // One frame period, rounded UP so the number can never understate. Pinned to the
  // digit, because these four are what a coach reads off the rate picker.
  near('30fps  is 33.4', err(30), 33.4, 0.001);
  near('60fps  is 16.7', err(60), 16.7, 0.001);
  near('120fps is 8.4', err(120), 8.4, 0.001);
  near('240fps is 4.2  — 8x better than 30, and allowed to say so', err(240), 4.2, 0.001);
  truthy('a faster clip is strictly better', err(240) < err(120) && err(120) < err(60) && err(60) < err(30));

  // ROUNDING UP IS THE POINT, so it is asserted rather than assumed: every figure
  // must be at or above the true frame period, never below it.
  for (const fps of [30, 60, 120, 240]) {
    truthy(`${fps}fps never understates`, err(fps) >= 1000 / fps - 1e-9);
  }
  check('ceilTenth rounds up, not to nearest', ceilTenth(8.3333), 8.4);
  check('and leaves an exact tenth alone', ceilTenth(4.2), 4.2);

  // Variable frame rate: the two marks can sit on frames of DIFFERENT lengths,
  // which is precisely why this takes durations rather than one fps number.
  //
  // A mixed pair takes the COARSER end whole, rather than landing between the two.
  // A measurement is only as good as its worst end, and averaging would hide which
  // end that was.
  const mixed = timeFromMarks({ pts: 0, frameDurSec: 1 / 30 }, { pts: 2, frameDurSec: 1 / 240 });
  near('a mixed-rate pair takes the coarser end', mixed.errorMs, err(30), 0.001);
  truthy('not the finer one', mixed.errorMs > err(240));

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
  // ONE DECIMAL on the +/-, because the figures now differ by a tenth where it
  // matters: 8.4 against 4.2 is the entire 120-vs-240 argument, and Math.round
  // flattened both to single digits.
  check('the same digits, but the honesty rides alongside', formatVideoTime(slow), '4.21s ± 33.4ms');
  check('and a faster clip says a smaller number', formatVideoTime(fast), '4.21s ± 4.2ms');

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

  // NEITHER IS FOLDED IN. errorMs is frame length and nothing else — a computed
  // number must not carry estimates, or a coach cannot tell which part was measured.
  //
  // And the relationship stated as a fact rather than an inequality that happens to
  // hold: at 30fps the frame is now the SAME SIZE as the bias estimate, which is the
  // honest reason 30 is a control and not an option.
  const t = timeFromMarks({ pts: 0, frameDurSec: 1 / 30 }, { pts: 2, frameDurSec: 1 / 30 });
  near('a 30fps frame is one whole frame, not a spread', t.errorMs, 33.4, 0.001);
  truthy('which is about the size of the bias estimate', Math.abs(t.errorMs - BODY_PART_BIAS_MS) < 5);
  // At the DEFAULT the margin is real, which is what keeps 120 defensible.
  const at120 = timeFromMarks({ pts: 0, frameDurSec: 1 / 120 }, { pts: 2, frameDurSec: 1 / 120 });
  truthy('while 120fps sits well inside it', at120.errorMs * 4 < BODY_PART_BIAS_MS);
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

  // CHANGED DELIBERATELY, and worth being explicit about because a test that moves
  // to match new behaviour is exactly how a regression gets waved through.
  //
  // This read `measuredFps(uneven) < 30`, which was a property of the OLD count-
  // over-span definition: eleven gaps across 0.433s gave 25.4. That number
  // described neither the camera nor the clip — it was the arithmetic mean dragged
  // down by one dropped frame.
  //
  // The median is chosen precisely so a dropped frame does not move it. The camera
  // recorded at 30fps and missed one; 30 is the honest answer, and the miss is
  // reported by isVariableRate, which is where it belongs. The two facts are
  // separate and are now stated separately.
  near('its measured rate is still the camera rate', measuredFps(uneven), 30, 0.001);
  truthy('with the dropped frame reported separately', isVariableRate(uneven));

  // And it does track a genuinely different rate, so robustness is not deafness.
  const at24 = ingestFrames(emptyGrid(), { from: 0, to: 1 }, cfr(0, 24, 20));
  near('a real 24fps clip measures 24', measuredFps(at24), 24, 0.001);
  const at240 = ingestFrames(emptyGrid(), { from: 0, to: 1 }, cfr(0, 240, 40));
  near('and a real 240fps clip measures 240', measuredFps(at240), 240, 0.001);

  check('too few frames to judge', measuredFps(emptyGrid()), null);
  check('and no false VFR claim from them', isVariableRate(emptyGrid()), false);
}

console.log('\n10. THE ROW carries its own accuracy');
{
  const raw = videoRunRawJson({ startPts: 1.5, endPts: 5.75, fps: 59.94, errorMs: 16.7 });
  const back = parseVideoRunJson(raw);
  near('start survives', back.startPts, 1.5, 1e-9);
  near('end survives', back.endPts, 5.75, 1e-9);
  near('the MEASURED fps survives, not a nominal one', back.fps, 59.94, 1e-9);
  near('and so does the error bar', back.errorMs, 16.7, 1e-9);

  // OLD ROWS ARE NOT RECOMPUTED, and they are not relabelled either. A row written
  // before the figure changed carries `quantSdMs` holding a standard deviation;
  // reading it back must return that number, not silently present it as a frame
  // period or drop it for zero.
  const legacy = JSON.stringify({
    engine: 'video',
    timeSource: 'video',
    exact: false,
    fps: 30,
    startPts: 0,
    endPts: 4,
    quantSdMs: 13.61,
  });
  near('a pre-change row keeps its own figure', parseVideoRunJson(legacy).errorMs, 13.61, 1e-9);
  truthy('rather than being zeroed', parseVideoRunJson(legacy).errorMs > 0);
  // And a row carrying BOTH prefers the new one, which is the only way a rewritten
  // row could ever be distinguished from a legacy one.
  const both = JSON.stringify({ ...JSON.parse(legacy), errorMs: 33.4 });
  near('a row with both prefers errorMs', parseVideoRunJson(both).errorMs, 33.4, 1e-9);

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

  // THE GAP BETWEEN TWO WINDOWS IS NOT DAMAGE, and this is the instance of the
  // island bug that cost real time rather than only reporting a wrong number.
  //
  // Every window boundary read as a hole, so a probe on a well-scrubbed clip
  // returned one repair per boundary — 39 of them after 40 windows, each an
  // extraction at ~25ms, on a perfectly CONSTANT clip. And it compounded: a repair
  // drops ONE frame into the middle of unprobed clip, splitting that gap in two,
  // so the next probe found two holes where it had found one. The repair budget
  // grew with every probe, which is what "lags badly and gets worse" looks like.
  let many = emptyGrid();
  for (let w = 0; w < 40; w += 1) {
    const k0 = w * 90;
    many = ingestFrames(
      many,
      { from: (k0 - 0.5) * dur, to: (k0 + 16.5) * dur },
      Array.from({ length: 17 }, (_, i) => (k0 + i) * dur),
    );
  }
  check('40 windows of a constant clip need 40 windows', many.windows.length, 40);
  check('and not one repair probe between them', gapProbes(many, dur), []);

  // A REAL hole still gets repaired — including one caused by a FAILED extraction
  // on a constant clip, which is why this path is not VFR-only machinery.
  const failedProbe = ingestFrames(
    emptyGrid(),
    { from: 0, to: 17 * dur },
    Array.from({ length: 17 }, (_, i) => i * dur).filter((_, i) => i !== 8),
  );
  check('a frame lost to a failed extraction is still repaired', gapProbes(failedProbe, dur).length, 1);
  near('at the midpoint of what is missing', gapProbes(failedProbe, dur)[0], 8 * dur, 1e-9);
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
    near(`${fps}fps: provisional equals settled for equal frames`, nominalErrorMs(1 / fps), settled.errorMs, 1e-9);
  }
  truthy('a faster clip still promises less error', nominalErrorMs(1 / 240) < nominalErrorMs(1 / 30));
  check('and a nonsense frame duration is not NaN', nominalErrorMs(-1), 0);
}

console.log('\n11e. GRID STATISTICS NEVER MEASURE ACROSS AN UNPROBED GAP');
{
  // The grid is ISLANDS. `frames` is one sorted array built from separate probed
  // windows with unprobed clip between them — the import alone makes two, one at
  // each end. Two entries adjacent in the ARRAY need not be adjacent in the VIDEO.
  //
  // Three functions treated them as one sequence, and all three were wrong on
  // EVERY clip, not only the exotic ones. Reproduced on a perfectly constant 30fps
  // clip: measuredFps read 0.67 after import and climbed to 5.63 as the coach
  // scrubbed, never converging; isVariableRate was true from the first frame; and
  // a mark on the trailing edge of a window took its frame duration from the gap —
  // 9466ms instead of 33.3ms, writing a +/-2733ms error bar onto a saved run.
  const dur = 1 / 30;
  const island = (from, n) => Array.from({ length: n }, (_, i) => from + i * dur);
  let g = ingestFrames(emptyGrid(), { from: 2 - dur, to: 2 + 9 * dur }, island(2, 9));
  g = ingestFrames(g, { from: 12 - dur, to: 12 + 9 * dur }, island(12, 9));

  check('two islands, one array', g.frames.length, 18);
  check('and two windows to say so', g.windows.length, 2);

  // MEASURED RATE is the median of real neighbour gaps, so it is right immediately
  // and does not drift as coverage grows.
  near('the rate is the real rate of the clip, not count over span', measuredFps(g), 30, 1e-6);
  const before = measuredFps(g);
  g = ingestFrames(g, { from: 20 - dur, to: 20 + 9 * dur }, island(20, 9));
  near('and probing more of the clip does not move it', measuredFps(g), before, 1e-9);

  // VARIABLE-RATE must not fire on the gaps between windows.
  check('a constant clip is not flagged variable', isVariableRate(g), false);

  // A genuinely variable island still is.
  const vfr = ingestFrames(emptyGrid(), { from: 0, to: 1 }, [0, dur, dur * 2, dur * 3.4, dur * 4.4]);
  check('a genuinely uneven island still is', isVariableRate(vfr), true);

  // THE ERROR BAR. The last frame of an island has no known successor, exactly as
  // the last frame of the clip does not.
  const mid = markAt(g, 2 + 3 * dur);
  near('a mark inside a window carries a real frame duration', mid.frameDurSec, dur, 1e-9);
  check('a mark on the last frame of an island resolves to nothing', markAt(g, 2 + 8 * dur), null);
  check('and cannot be stepped onto either', stepFrames(g, 2 + 7 * dur, 1), null);
  truthy('while stepping within the island is unaffected', stepFrames(g, 2 + 3 * dur, 1) !== null);

  // The deltas themselves: 8 real gaps per 9-frame island, and not one gap of 10s.
  const deltas = adjacentDeltas(g);
  check('three islands give 8 neighbour gaps each', deltas.length, 24);
  truthy('and none of them is an unprobed span', Math.max(...deltas) < dur * 1.5);

  // COVERAGE IS WIDER THAN USABILITY, and probeGridAround has to allow for it.
  //
  // A window runs one frame past the last frame in it, so its final frame has no
  // in-window successor and cannot be resolved. That makes the region where marks
  // actually work one frame narrower than the region isCovered() reports, at each
  // end — and probeGridAround's early exit checks coverage. Requiring only the
  // frames the coach is standing on let it skip a probe while they stood on the
  // unusable edge, so forward stepping stalled with nothing willing to extend the
  // window. It now demands one frame MORE than it needs, which is why.
  const anchor = 2.0;
  const one = ingestFrames(
    emptyGrid(),
    { from: anchor - 8 * dur, to: anchor + 9 * dur },
    Array.from({ length: 17 }, (_, i) => anchor + (i - 8) * dur),
  );
  const edge = anchor + 8 * dur;
  truthy('the covered region includes the last frame of a window', isCovered(one, edge));
  check('but that frame cannot be resolved', markAt(one, edge), null);
  check('nor stepped onto from the frame before', stepFrames(one, anchor + 7 * dur, 1), null);
  truthy(
    'so a 2-frame margin still reports covered where stepping already fails',
    isCovered(one, anchor + 7 * dur + 2 * dur),
  );
  check(
    'while a 3-frame margin does not, and forces the probe that unsticks it',
    isCovered(one, anchor + 7 * dur + 3 * dur),
    false,
  );
}

console.log('\n11f. TIME-SCALED CLIPS ARE REFUSED, not corrected');
{
  // A rendered slow-motion clip has its duration stretched by the slow-motion
  // factor, and nothing in the file says so. Correcting is not on the table: the
  // iPhone ramp slows only a SEGMENT, so there is no single divisor — a mark inside
  // the slow section, one outside it and one straddling the boundary each need a
  // different number. Dividing anyway turns a visibly absurd time into a believable
  // wrong one, which is the failure a coach cannot catch.
  const slow = acceptForTiming('slow-motion');
  check('slow motion cannot be timed', slow.accept, false);
  truthy('and the refusal says why, not just no', slow.reason.length > 80);
  truthy('naming the ramp, since that is why it cannot be corrected', /ramp/i.test(slow.reason));

  const lapse = acceptForTiming('time-lapse');
  check('time-lapse cannot be timed either', lapse.accept, false);
  // The more dangerous direction: compressed time reads as a personal best.
  truthy('and it says the time comes out too FAST', /fast|best/i.test(lapse.reason));

  check('an ordinary clip is accepted', acceptForTiming('normal'), { accept: true, warn: null });

  // UNKNOWN IS NOT REFUSED. A clip from Files has no photo-library asset to ask,
  // and blocking every unidentifiable clip is worse than the risk it covers.
  const unknown = acceptForTiming('unknown');
  check('an unidentifiable clip is allowed through', unknown.accept, true);
  truthy('but it is warned about', (unknown.warn ?? '').length > 0);

  // REVIEW is deliberately more permissive: nothing computes a time from attached
  // footage, and watching a sprint in slow motion is the point of filming it.
  check('slow motion may still be ATTACHED for review', acceptForReview('slow-motion').accept, true);
  truthy(
    'with a note that it cannot be used for timing',
    /cannot be used to mark a time/i.test(acceptForReview('slow-motion').warn),
  );
  check('and an ordinary clip attaches silently', acceptForReview('normal'), { accept: true, warn: null });
}

console.log('\n11g. STEPPING NEVER CROSSES AN ISLAND');
{
  // The island bug's fifth site, and the one that survived four rounds of fixing
  // it. measuredFps, isVariableRate, markAt and gapProbes all learned to ask which
  // window a frame belongs to; stepFrames still did `i + delta` on the flat array.
  //
  // frameDurAt does not catch it. It asks whether the LANDING frame has a successor
  // inside its own window, and a frame in the middle of the next island passes that
  // happily. Only the pair of frames — where you left and where you arrived — shows
  // the crossing.
  const D = 1 / 30;
  let g = emptyGrid();
  const head = [];
  for (let k = 0; k < 6; k += 1) head.push(k * D);
  g = ingestFrames(g, { from: 0, to: 6 * D }, head);
  const tail = [];
  for (let k = 0; k < 6; k += 1) tail.push(20 + k * D);
  g = ingestFrames(g, { from: 20, to: 20 + 6 * D }, tail);

  check('two windows, twelve frames, one array', g.frames.length, 12);
  check('and the array hides the gap', g.windows.length, 2);

  // Standing on frame 2 of the head island. Frames 3 and 4 are real neighbours;
  // frame 5 is the last of its window so its duration is unknown; anything beyond
  // is a different part of the clip.
  const at = 2 * D;
  near('+1 is the next frame', stepFrames(g, at, 1).pts, 3 * D, 1e-9);
  near('+2 likewise', stepFrames(g, at, 2).pts, 4 * D, 1e-9);
  check('+3 refused — last frame of the window, duration unknown', stepFrames(g, at, 3), null);

  // THE SIGNATURE THAT MAKES THIS SO BAD: before the fix, +3 was refused and +4
  // succeeded, twenty seconds away. The refusal was bypassed by pressing HARDER,
  // which is exactly what a coach does when the arrows appear to do nothing — and
  // the step worker coalesces held presses into one large delta, so it is a normal
  // way to use the screen rather than a stress test.
  check('+4 does not jump to the next island', stepFrames(g, at, 4), null);
  check('nor +5', stepFrames(g, at, 5), null);
  check('nor +8', stepFrames(g, at, 8), null);

  // Backwards too. The same arithmetic, the same hole.
  const at2 = 20 + 2 * D;
  near('-1 within the island', stepFrames(g, at2, -1).pts, 20 + D, 1e-9);
  check('-3 refused at the edge', stepFrames(g, at2, -3), null);
  check('-4 does not fall back into the head island', stepFrames(g, at2, -4), null);

  // A CONTIGUOUS grid must be unaffected — the fix must refuse gaps, not distance.
  let one = emptyGrid();
  const all = [];
  for (let k = 0; k < 12; k += 1) all.push(k * D);
  one = ingestFrames(one, { from: 0, to: 12 * D }, all);
  check('one window, one island', one.windows.length, 1);
  near('a long step inside one island is fine', stepFrames(one, 2 * D, 8).pts, 10 * D, 1e-9);
  check('and the window edge still refuses', stepFrames(one, 2 * D, 9), null);
}

console.log('\n11h. PROBING STOPS AT THE END OF THE CLIP — and still finds the last frame');
{
  // WALKED, NOT REASONED ABOUT. Narrowing coverage near a window edge has already
  // produced one stepping regression on this screen: the last frame of a window has
  // no successor, so markAt refuses it, so the USABLE region is a frame narrower
  // than the covered one at each end. Cutting the tail probes wholesale would take
  // another frame off that — silently, and only at the finish mark.
  //
  // So this drives the real probeGridAround against a decoder that behaves like
  // AVFoundation (a request past the end returns the last frame), then walks a mark
  // through the final window one press at a time.
  // A PARTIAL FINAL FRAME, because that is the real case. Clip durations are not
  // multiples of the frame period, so the last frame is a short remainder — here
  // 10ms of a 33ms period. A rescue probe aimed half a frame back would land in
  // frame 59 and never discover frame 60, which is the failure this block exists to
  // make visible: it costs the SECOND-to-last frame, one further in than it looks.
  const FPS = 30;
  const D = 1 / FPS;
  const DURATION = 2.01; // frames 0..60; frame 60 starts at 2.000 and runs 10ms
  const LAST = 60;
  /** The last frame that can be MARKED: 60 has no successor, so its length is
   *  unknown and an error bar computed from it would be invented. */
  const LAST_MARKABLE = LAST - 1;

  const fakePlayer = () => {
    let calls = 0;
    return {
      duration: DURATION,
      seen: () => calls,
      generateThumbnailsAsync: async ([t]) => {
        calls += 1;
        if (!(t >= 0)) return [];
        // AVFoundation clamps a request past the end to the last frame rather than
        // failing — which is why the unbounded version looked harmless.
        const i = Math.min(LAST, Math.floor(t / D + 1e-9));
        return [{ actualTime: i * D }];
      },
    };
  };

  // Centred a few frames back from the end, NOT on the last frame. Anchoring on the
  // final frame would let the anchor call discover it single-handed and hide
  // whether the tail probes did their job at all.
  const p = fakePlayer();
  const r = await probeGridAround(p, emptyGrid(), 58 * D, D);

  // 1 anchor + the aligned probes that fall inside the clip + ONE kept tail probe.
  // The point is not the exact number but that it is far below the unbounded 18.
  truthy(`the tail costs fewer than 18 calls (was ${r.calls})`, r.calls < 18);
  truthy('and more than a bare anchor', r.calls > 1);

  // THE FRAME THAT MATTERS. Without the kept tail probe the last frame is never
  // discovered, and then the second-to-last has no successor and becomes
  // unmarkable — the regression, one frame further in than it looks.
  const has = (i) => r.grid.frames.some((f) => Math.abs(f - i * D) < 1e-6);
  truthy('the short final frame was found', has(LAST));
  truthy('and so was the one before it', has(LAST_MARKABLE));
  // The consequence, stated as the coach meets it rather than as a frame list.
  truthy('so the last markable frame really is markable', markAt(r.grid, LAST_MARKABLE * D) !== null);

  // WALK IT. Start well inside the probed tail and press "next frame" repeatedly,
  // asserting each press moves exactly one frame until the clip legitimately runs
  // out. A stall shows up as a refusal arriving EARLY; a crossing shows up as a
  // jump. Neither can hide in an aggregate.
  let at = (LAST - 6) * D;
  const walked = [];
  for (let press = 0; press < 10; press += 1) {
    const m = stepFrames(r.grid, at, 1);
    if (!m) break;
    walked.push(Math.round(m.pts / D));
    at = m.pts;
  }
  check('every press advances exactly one frame', walked, [
    LAST - 5,
    LAST - 4,
    LAST - 3,
    LAST - 2,
    LAST - 1,
  ]);

  // WHERE IT STOPS IS THE WHOLE ASSERTION. Stopping at 59 is correct — frame 60 has
  // no successor. Stopping at 58 is the regression, and it is invisible on device:
  // the arrows simply go dead one frame early, at the finish mark, where the coach
  // is least likely to blame the tool.
  check('the walk ends on the last MARKABLE frame', walked[walked.length - 1], LAST_MARKABLE);
  check('and one more press is refused', stepFrames(r.grid, LAST_MARKABLE * D, 1), null);

  // The drag clamp agrees with the walk, so dragging and stepping cannot disagree
  // about where the end of the clip is.
  const clamp = lastMarkableTime(DURATION, D);
  truthy('the drag clamp stops no later than the walk', Math.floor(clamp / D + 1e-9) <= LAST_MARKABLE);
  truthy('and no earlier than one frame before it', Math.floor(clamp / D + 1e-9) >= LAST_MARKABLE - 1);

  // MID-CLIP IS UNCHANGED. The clamp must cost nothing where the tail is not near.
  const p2 = fakePlayer();
  const mid = await probeGridAround(p2, emptyGrid(), 1.0, D);
  check('a mid-clip probe still costs anchor plus seventeen', mid.calls, 18);

  // And a walk through the middle advances one frame at a time for as far as the
  // window reaches, with no refusal in the interior.
  let at2 = 1.0;
  let steps = 0;
  for (let press = 0; press < 6; press += 1) {
    const m = stepFrames(mid.grid, at2, 1);
    if (!m) break;
    near(`mid-clip press ${press + 1} moves one frame`, m.pts - at2, D, 1e-6);
    at2 = m.pts;
    steps += 1;
  }
  check('six presses, six frames, no early refusal', steps, 6);
}

console.log('\n11i. A CLIP WE RECORDED IS NOT A CLIP WE CANNOT CHECK');
{
  // The trap this exists to close. acceptForTiming has an 'unknown' branch that
  // accepts with "this clip is not from your photo library, so it cannot be checked
  // for slow motion" — correct for a file picked out of Files, and false for a clip
  // the app recorded itself. We set the capture rate and wrote the file; there is no
  // Photos round trip and therefore no rendered version to be handed instead of the
  // original, which is the entire mechanism the refusal exists for.
  //
  // Without its own value, in-app recording lands in 'unknown' and every recorded
  // run carries a caveat about a risk it does not have — on the happy path, forty
  // times a session, until the coach stops reading caveats.
  const rec = acceptForTiming('recorded');
  check('a recorded clip is accepted', rec.accept, true);
  check('and says NOTHING', rec.warn ?? null, null);

  // The contrast that makes it worth a value of its own.
  const unk = acceptForTiming('unknown');
  check('an unchecked clip is still accepted', unk.accept, true);
  truthy('but warned about', !!unk.warn);
  truthy('naming the photo library as the reason', /photo library/i.test(unk.warn));

  // THE REFUSALS ARE UNTOUCHED. Adding a way to say "we know this one" must not
  // become a way to skip the check on clips that still need it.
  check('slow motion is still refused', acceptForTiming('slow-motion').accept, false);
  check('time-lapse too', acceptForTiming('time-lapse').accept, false);
  truthy('and the slow-motion reason still explains the rendered version', /slowed version/i.test(acceptForTiming('slow-motion').reason));

  // Review is more permissive by design and stays that way: nothing computes a time
  // from attached footage, and watching a sprint in slow motion is why you film it
  // that way.
  check('review accepts a recorded clip', acceptForReview('recorded').accept, true);
  check('silently', acceptForReview('recorded').warn ?? null, null);
  check('and still accepts slow motion', acceptForReview('slow-motion').accept, true);
  truthy('with the caveat that it cannot be timed', /cannot be used to mark a time/i.test(acceptForReview('slow-motion').warn));

  // 'normal' is a photo-library clip CHECKED and found ordinary; 'recorded' is one
  // that never needed checking. Same outcome, different claim — and both silent, so
  // the difference must be visible in the type rather than in the message.
  check('normal is silent too', acceptForTiming('normal').warn ?? null, null);
  truthy('but they are different values', 'normal' !== 'recorded');
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

console.log('\n14. THE SNAPPING LOCK — a span is not two points');
{
  // FOUND ON DEVICE, REPRODUCED OFFLINE. The marking screen would stick on
  // SNAPPING permanently: not slow, stuck, until the clip was reloaded. Two wrong
  // diagnoses preceded this one, and neither survived contact with a simulation.
  //
  // probeGridAround decided whether to re-probe by asking isCovered about the two
  // EDGES of the span it needed and inferring the middle. Windows are merged and
  // non-overlapping, so that holds until a mark lands in a gap NARROWER than
  // 2*margin: both edges sit in the windows either side, the centre sits in the
  // hole, the probe is skipped, and markAt can never resolve the point — for good,
  // because every later release runs the same test and skips the same probe.
  //
  // The exact geometry from the reproduction, so a regression names itself.
  const gappy = {
    frames: [14.5, 14.5333, 14.5667, 14.6667, 14.7, 14.7333],
    windows: [
      { from: 0, to: 14.5667 },
      { from: 14.6667, to: 15.2333 },
    ],
  };
  const centre = 14.6341;
  const margin = 0.1;

  truthy('both EDGES of the span are covered', isCovered(gappy, centre - margin) && isCovered(gappy, centre + margin));
  check('while the centre itself is not', isCovered(gappy, centre), false);
  // Which is the whole point: edge-sampling says yes, the span says no.
  check('so asking about the SPAN refuses', spanCovered(gappy, centre - margin, centre + margin), false);

  // And it still says yes when the span really is inside one window, or the early
  // exit would never fire and every release would pay a full probe.
  truthy('a span inside one window is covered', spanCovered(gappy, 14.51, 14.56));
  check('a span crossing a window edge is not', spanCovered(gappy, 14.55, 14.60), false);
  check('nor is one spanning both windows', spanCovered(gappy, 14.5, 14.75), false);
  check('an empty grid covers nothing', spanCovered(emptyGrid(), 0, 1), false);
  // Order must not matter: the caller passes centre-margin first, but a negative
  // margin or a reversed pair must not silently answer yes.
  check('the ends may be given in either order', spanCovered(gappy, 14.56, 14.51), true);
}

console.log('\n15. A DISABLED CONTROL SAYS WHY');
{
  // Keep was gated on `timing` and said nothing, so a permanently stuck grid and a
  // mark parked past the last frame looked identical: a button that did not
  // respond. That cost a device session and two wrong diagnoses.
  check('both marks resolved needs no explanation', whyNotTimeable({ frameCount: 40, startResolved: true, finishResolved: true }), null);

  const none = whyNotTimeable({ frameCount: 0, startResolved: false, finishResolved: false });
  truthy('nothing read at all says so', /No frames could be read/i.test(none));
  truthy('and suggests loading it again', /again/i.test(none));

  const neither = whyNotTimeable({ frameCount: 40, startResolved: false, finishResolved: false });
  truthy('frames but no marks is a different sentence', /Neither mark/i.test(neither));
  check('and is NOT the no-frames one', /No frames could be read/i.test(neither), false);

  const start = whyNotTimeable({ frameCount: 40, startResolved: false, finishResolved: true });
  const finish = whyNotTimeable({ frameCount: 40, startResolved: true, finishResolved: false });
  truthy('an unresolved START names the start', /start mark/i.test(start));
  truthy('an unresolved FINISH names the finish', /finish mark/i.test(finish));
  check('and the two are not the same message', start === finish, false);
  // The distinction the coach acts on: one mark unresolved is a position they can
  // fix by moving that handle, and the message has to say which handle.
  // WORDED FOR AFTER THE RETRY. The screen only reaches these once probeToResolve
  // has probed around the mark and once past it, so the message must not imply the
  // coach is being asked to do the app's job — it is reporting a region that will
  // not decode.
  truthy('both say the retry already happened', /looking again/i.test(start) && /looking again/i.test(finish));
  truthy('and still offer an action', /Move it a little/i.test(start) && /pick a different moment/i.test(finish));
}

console.log('\n16. WIDEN, DO NOT SNAP — an edge mark is resolved by measuring');
{
  // A mark fails to resolve when its frame is the LAST in its probed window: the
  // successor is across an unprobed gap, so the frame's DURATION is unknown and
  // markAt refuses rather than invent an error bar. Correct, and kept.
  //
  // The cure is to take the missing measurement, not to move the mark. Snapping to
  // the nearest resolvable frame would relocate the coach's mark silently — 8ms a
  // frame at 120fps — and would HIDE the gap rather than fill it, so the next mark
  // in that region hits the same edge.

  /** A decoder that clamps past-the-end requests, as AVFoundation does. */
  const player = (fps, durationSec) => {
    const d = 1 / fps;
    const lastIndex = Math.floor(durationSec / d) - 1;
    return {
      duration: durationSec,
      async generateThumbnailsAsync(times) {
        return times
          .map((t) => {
            if (!(t >= 0)) return null;
            const i = Math.min(lastIndex, Math.floor(t / d + 1e-9));
            return i < 0 ? null : { actualTime: i * d };
          })
          .filter(Boolean);
      },
    };
  };

  const d = 1 / 30;
  // A window that CLAIMS more than its frames reach: covered to 1.0, frames stop at
  // 0.5. That is the shape a settle leaves behind at a window edge.
  const frames = [];
  for (let i = 0; i * d <= 0.5 + 1e-9; i += 1) frames.push(Number((i * d).toFixed(6)));
  const edgeGrid = { frames, windows: [{ from: 0, to: 1.0 }] };
  const at = frames[frames.length - 1];

  check('the mark is UNRESOLVABLE — its frame has no measured successor', markAt(edgeGrid, at), null);
  truthy('while the span around it reads as covered', spanCovered(edgeGrid, at - 3 * d, at + 3 * d));
  // Which together are why a plain probe cannot help: it early-exits on the span.
  const plain = await probeGridAround(player(30, 3), edgeGrid, at, d);
  check('so a plain probe does nothing at all', plain.calls, 0);
  check('and the mark is still unresolvable afterwards', markAt(plain.grid, at), null);

  // The widening probe steps PAST the edge, which is what gives that frame a
  // successor to measure.
  const fixed = await probeToResolve(player(30, 3), edgeGrid, at, d);
  check('probeToResolve resolves it', fixed.resolved, true);
  truthy('by actually probing', fixed.calls > 0);
  truthy('and the mark now resolves', !!markAt(fixed.grid, at));

  // THE MARK DID NOT MOVE. This is the difference from snapping, stated as an
  // assertion so a future "just snap it" cannot pass quietly.
  check('at the same timestamp the coach chose', markAt(fixed.grid, at).pts, at);
  truthy('with a MEASURED duration, not an assumed one', Math.abs(markAt(fixed.grid, at).frameDurSec - d) < 1e-6);

  // Already-resolvable marks must not pay for the retry.
  const mid = frames[3];
  const cheap = await probeToResolve(player(30, 3), edgeGrid, mid, d);
  check('a resolvable mark resolves without widening', cheap.resolved, true);
  check('and costs nothing', cheap.calls, 0);

  // BOUNDED. A decoder that returns nothing cannot be searched into submission —
  // the caller is told, and says so, rather than probing forever.
  const dead = { duration: 3, async generateThumbnailsAsync() { return []; } };
  const hopeless = await probeToResolve(dead, emptyGrid(), 1.0, d);
  check('a decoder returning nothing gives up', hopeless.resolved, false);
  truthy('after a bounded number of calls', hopeless.calls > 0 && hopeless.calls <= 4);
}

console.log('\n17. A WINDOW CLAIMS ONLY WHAT CAME BACK');
{
  // THE ROOT OF THE SNAPPING LOCK, third and final direction. Two rounds fixed two
  // symptoms; this is the cause both of them were downstream of.
  //
  // ingestFrames recorded the range that was ASKED about. Every failed extraction
  // therefore left a hole under a claimed span — and a claimed span with no frames
  // in it is a mark that cannot resolve and will never be probed again, because
  // probeGridAround sees "covered" and declines. spanCovered fixed the two-window
  // version of this; it cannot fix the one-window version, where the hole is inside.
  const d = 1 / 30;

  // The unit rule first.
  const asked = { from: 1.0, to: 2.0 };
  check('nothing found claims nothing', coveredWindow(asked, [], 5), { from: 1.0, to: 1.0 });
  check('frames stopping short shorten the claim', coveredWindow(asked, [1.0, 1.2, 1.4], 5), { from: 1.0, to: 1.4 });
  check('and a late start raises the floor', coveredWindow(asked, [1.6, 1.8], 5), { from: 1.6, to: 1.8 });
  check('the claim never exceeds the ask', coveredWindow(asked, [0.5, 3.0], 5), { from: 1.0, to: 2.0 });
  // THE TAIL IS THE DELIBERATE EXCEPTION: past the clip's end nothing exists, and
  // treating that as unprobed would make every step near the finish re-probe it.
  check('past the clip end the ask is kept', coveredWindow({ from: 4.5, to: 5.5 }, [4.5, 4.9], 5), { from: 4.5, to: 5.5 });

  /** A decoder that FAILS inside a band, which is what leaves a hole under a claim. */
  const flaky = (fps, durationSec, deadFrom, deadTo) => {
    const step = 1 / fps;
    const lastIndex = Math.floor(durationSec / step) - 1;
    return {
      duration: durationSec,
      async generateThumbnailsAsync(times) {
        return times
          .map((t) => {
            if (!(t >= 0)) return null;
            if (t >= deadFrom && t <= deadTo) return null;
            const i = Math.min(lastIndex, Math.floor(t / step + 1e-9));
            return i < 0 ? null : { actualTime: i * step };
          })
          .filter(Boolean);
      },
    };
  };

  // Probe centred just BELOW a dead band, so the window's upper half falls in it.
  const player = flaky(30, 15, 1.10, 1.60);
  const r = await probeGridAround(player, emptyGrid(), 1.0, d);
  const w = r.grid.windows[0];
  const top = Math.max(...r.grid.frames);

  truthy('the probe found frames', r.grid.frames.length > 2);
  truthy('and its window stops at the last one it actually got', Math.abs(w.to - top) < 1e-6);
  // THE ASSERTION THAT MATTERS: the dead band is NOT claimed.
  check('a region the decoder refused is not covered', isCovered(r.grid, 1.45), false);
  // Which is what lets the next probe run instead of early-exiting forever.
  const again = await probeGridAround(flaky(30, 15, 1.10, 1.60), r.grid, 1.45, d);
  truthy('so a later probe there is not skipped', again.calls > 0);

  // And once the decoder recovers, the region resolves — no lock, no nudging.
  const healthy = { duration: 15, async generateThumbnailsAsync(times) {
    return times.map((t) => (t >= 0 ? { actualTime: Math.floor(t / d + 1e-9) * d } : null)).filter(Boolean);
  } };
  const healed = await probeToResolve(healthy, r.grid, 1.45, d);
  check('a recovered decoder resolves the mark', healed.resolved, true);
  truthy('with a one-frame duration, not one spanning the hole', Math.abs(markAt(healed.grid, 1.45).frameDurSec - d) < 1e-6);
}

console.log('\n18. A CLIP REPORTS ITS OWN LENGTH AND RATE, NOT THE LAST ONE\'S');
{
  // CONFIRMED ON DEVICE FROM TWO SYMPTOMS AT ONCE, and they turned out to be one bug.
  //
  //   duration   a 0.7s recording reported 7 seconds — the clip before it — so the
  //              finish handle was clamped into space the clip does not contain.
  //   frameDur   the probe aims using this seed, so a seed one rate BELOW the truth
  //              samples every second frame and measuredFps reports exactly half.
  //              "60 measures 30, 120 measures 60" was never a camera degrading; it
  //              was the probe measuring the PREVIOUS clip's grid, and layer 3
  //              refusing a good recording and blaming the hardware.
  //
  // waitForClip could not fix this and did not: it waits for duration > 0 and a
  // readable track, and the stale values satisfy both instantly.

  /** A player that behaves like expo-video: replaceAsync RESOLVES while duration and
   *  the track still describe the previous source, for `lag` polls. */
  //
  // THE CLEAR LAGS TOO, and that detail is the test. Modelling replaceAsync(null) as
  // instant left nothing for the confirmation loop to wait on, so deleting that loop
  // survived the mutation — the fixture was proving half the fix.
  const laggyPlayer = (lag) => {
    // WHAT THE PLAYER REPORTS lags what it was asked to load, and during that window
    // it reports the PREVIOUS clip — not null, not zero. That is the entire bug, and
    // two earlier versions of this fixture modelled the gap as null instead, which
    // made the clear look unnecessary and let the mutation survive.
    //
    // The TRACK settles after the duration, which is why waiting on duration alone
    // was never enough even before staleness was understood.
    let shown = null;
    let shownTrack = null;
    let target = null;
    let left = 0;
    let trackLeft = 0;
    const tick = () => {
      if (left > 0) {
        left -= 1;
        if (left === 0) shown = target;
      }
      if (trackLeft > 0) {
        trackLeft -= 1;
        if (trackLeft === 0) shownTrack = target;
      }
    };
    return {
      get duration() {
        tick();
        return shown ? shown.duration : 0;
      },
      get videoTrack() {
        tick();
        return shownTrack ? { frameRate: shownTrack.fps } : null;
      },
      availableVideoTracks: [],
      async replaceAsync(source) {
        target = source;
        left = Math.max(1, lag);
        trackLeft = Math.max(1, lag) + 4;
      },
    };
  };

  // The first clip: 7 seconds at 30fps.
  const p = laggyPlayer(1);
  await p.replaceAsync({ duration: 7.0, fps: 30 });
  const first = await loadClipInto(p, { duration: 7.0, fps: 30 }, 500);
  check('the first clip reads its own length', first.durationSec, 7.0);
  check('and its own rate', Math.round(1 / first.frameDurSec), 30);

  // Now a 0.7s clip at 60fps, on a player that lags. THE DEVICE CASE.
  const laggy = laggyPlayer(6);
  await laggy.replaceAsync({ duration: 7.0, fps: 30 });
  // FULLY LOAD IT FIRST. The first version of this fixture skipped this, so the
  // player never held a previous clip and the whole block passed against the OLD
  // behaviour too — a test that could not fail, which is worse than no test. Caught
  // by mutating loadClipInto back and watching nothing happen.
  while ((laggy.duration || 0) === 0 || !laggy.videoTrack) await new Promise((r) => setTimeout(r, 5));
  check('the previous clip really is loaded', laggy.duration, 7.0);
  check('and its track is the stale one', laggy.videoTrack.frameRate, 30);

  const second = await loadClipInto(laggy, { duration: 0.7, fps: 60 }, 2000);
  check('a short clip after a long one reports ITS length', second.durationSec, 0.7);
  truthy('not the previous 7 seconds', second.durationSec !== 7.0);
  check('and ITS frame rate', Math.round(1 / second.frameDurSec), 60);
  truthy('not the previous 30 — the half-measurement ladder', Math.round(1 / second.frameDurSec) !== 30);
  check('with the rate marked readable', second.tracked, true);

  // THE LADDER, stated as the consequence rather than the mechanism: a seed one rate
  // below the truth can only ever measure half, whatever the camera did.
  const seededLow = 1 / 30;
  const realFrames = [];
  for (let i = 0; i < 20; i += 1) realFrames.push(i / 60);
  // Aiming at 1/30 centres on a 60fps clip hits every second frame.
  const hit = new Set();
  for (let k = 0; k < 10; k += 1) {
    const t = (k + 0.5) * seededLow;
    let best = 0;
    for (const f of realFrames) if (f <= t + 1e-9) best = f;
    hit.add(Number(best.toFixed(6)));
  }
  const gaps = [...hit].sort((a, b) => a - b).slice(1).map((f, i) => f - [...hit].sort((a, b) => a - b)[i]);
  truthy('a 1/30 seed on a 60fps clip only ever finds 30fps spacing',
    gaps.every((g) => Math.abs(g - 1 / 30) < 1e-6));
}

console.log('\n19. A SETTLE RESOLVES THE MARK NOBODY IS TOUCHING');
{
  // THE DEVICE SIGNATURE THIS EXISTS FOR: `probe 239ms/18 start:ok finish:NULL`.
  //
  // Eighteen calls, no UNRESOLVED, and a clip that cannot be timed. Three fixes each
  // moved that symptom without removing it, because all three were aimed at the wrong
  // question. The probe was not failing. It was never pointed at the failing mark.
  //
  // A settle probes ONE position — the handle just released. A mark stranded by some
  // earlier settle is never examined again, so every later settle on the other handle
  // truthfully reports resolved:true while Keep stays disabled and the readout sits
  // on SNAPPING. Recovery was by luck: the coach had to happen to drag the stranded
  // handle.
  //
  // A decoder that will not return one particular frame, which is what leaves the
  // hole in the first place.
  const D = 1 / 30;
  const holeAt = (bad) => ({
    duration: 6,
    async generateThumbnailsAsync(times) {
      const out = [];
      for (const t of times) {
        if (t < 0 || t >= 6) continue;
        const i = Math.floor(t / D + 1e-9);
        if (bad.has(i)) continue;
        out.push({ actualTime: Number((i * D).toFixed(6)) });
      }
      return out;
    },
  });

  // A grid with the finish mark stranded: covered, but with no frame that has a
  // measured successor at that position.
  const stranded = { frames: [], windows: [{ from: 0, to: 0.4 }, { from: 3.0, to: 3.4 }] };
  for (let i = 0; i * D <= 0.4 + 1e-9; i += 1) stranded.frames.push(Number((i * D).toFixed(6)));
  stranded.frames.push(3.0);
  const startPos = stranded.frames[2];
  const finishPos = 3.0;

  truthy('the mark under the finger resolves', !!markAt(stranded, startPos));
  check('the OTHER mark does not', markAt(stranded, finishPos), null);

  // What the old one-mark settle did. probeToResolve is still exported and still
  // right for what it does; the point is what it leaves behind.
  const oneMark = await probeToResolve(holeAt(new Set()), stranded, startPos, D);
  check('a one-mark settle calls it resolved', oneMark.resolved, true);
  check('while the other mark is still unresolvable', markAt(oneMark.grid, finishPos), null);
  // Which is the lie exactly: a settle that reports success and leaves the screen
  // unable to time the clip.

  const both = await resolveMarks(holeAt(new Set()), stranded, startPos, finishPos, D);
  check('resolveMarks resolves the moved mark', both.movedResolved, true);
  check('AND the one nobody touched', both.otherResolved, true);
  truthy('the stranded mark now reads back', !!markAt(both.grid, finishPos));
  truthy('and the moved mark still does', !!markAt(both.grid, startPos));

  // NEITHER MARK MOVED. Repairing by relocating a handle would hide the gap rather
  // than fill it, and would change the time the coach recorded without saying so.
  check('the finish mark is at the timestamp it was already on', markAt(both.grid, finishPos).pts, finishPos);
  truthy('with a MEASURED duration', Math.abs(markAt(both.grid, finishPos).frameDurSec - D) < 1e-6);

  // FREE WHEN THERE IS NOTHING TO REPAIR. The second probe must cost no extractions
  // on the happy path, or every settle in an ordinary session pays for a rescue that
  // is not needed. markAt is a pure array scan; that is the whole reason this is
  // affordable.
  //
  // Stated as a COMPARISON against the one-mark probe on the same grid, not as an
  // absolute call count. An absolute count silently folds in whatever the moved
  // mark's own probe cost, and the first version of this assertion did exactly that
  // and failed at 12 — a number that was entirely the moved mark's, and said nothing
  // about the second one.
  const healthy = { frames: [], windows: [{ from: 0, to: 1.0 }] };
  for (let i = 0; i * D <= 1.0 + 1e-9; i += 1) healthy.frames.push(Number((i * D).toFixed(6)));
  //
  // The other mark is deliberately placed where a probe WOULD cost extractions if one
  // ran — resolvable, but close enough to the window edge that spanCovered is false.
  // The first version of this put it in the middle of the window, where a probe
  // early-exits at zero calls anyway, so "costs nothing" was true whether the skip
  // worked or not. A mutation that removed the skip entirely passed it.
  const movedAt = healthy.frames[8];
  const otherAt = healthy.frames[28];
  const wouldCost = await probeToResolve(holeAt(new Set()), healthy, otherAt, D);
  truthy('probing the other mark would not be free', wouldCost.calls > 0);
  const alone = await probeToResolve(holeAt(new Set()), healthy, movedAt, D);
  truthy('a healthy pair needs no probing at all', alone.calls === 0);
  const cheap = await resolveMarks(holeAt(new Set()), healthy, movedAt, otherAt, D);
  check('and resolving BOTH costs exactly what resolving one did', cheap.calls, alone.calls);
  check('and both are reported resolved', cheap.movedResolved && cheap.otherResolved, true);

  // HONEST WHEN IT CANNOT. A frame the decoder will not hand back stays unreadable,
  // and the answer is to SAY so — this is what puts UNRESOLVED on the perf line and
  // the "will not read back" message on screen, instead of a silent SNAPPING.
  const dead = { duration: 6, async generateThumbnailsAsync() { return []; } };
  const cannot = await resolveMarks(dead, stranded, startPos, finishPos, D);
  check('an unreadable region is reported, not hidden', cannot.otherResolved, false);
  truthy('after a bounded number of calls', cannot.calls > 0 && cannot.calls <= 8);
}

console.log(
  failures === 0
    ? '\nRESULT: OK — video timing, series grouping and lazy grid rules hold.\n'
    : `\nRESULT: ${failures} FAILURE(S)\n`,
);
process.exit(failures === 0 ? 0 : 1);
