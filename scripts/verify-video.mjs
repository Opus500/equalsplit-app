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
  nominalSdMs,
  adjacentDeltas,
  acceptForTiming,
  acceptForReview,
} = await import('../src/video/timing.ts');
const { restRepRawJson, runStartSource, REPEAT_MODE } = await import('../src/ble/repeats.ts');
// The REAL probe path. frames.ts imports expo-video for types only, so it loads
// standalone — which is what lets block 11h drive it against a fake decoder rather
// than reasoning about what it would do.
const { probeGridAround } = await import('../src/video/frames.ts');
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

  // WHERE THE LINE IS DRAWN, read off the real grouping rule. Video joins gate
  // because the difference between them is bounded by a body — roughly a frame
  // either way. Hand does not, because human reaction time is larger than the
  // trend being plotted and has the spread to match.
  const vid = videoRunRawJson({ startPts: 0, endPts: 4, fps: 30, quantSdMs: 13.6 });
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
    near(`${fps}fps: provisional equals settled for equal frames`, nominalSdMs(1 / fps), settled.quantSdMs, 1e-9);
  }
  truthy('a faster clip still promises less error', nominalSdMs(1 / 240) < nominalSdMs(1 / 30));
  check('and a nonsense frame duration is not NaN', nominalSdMs(-1), 0);
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

console.log(
  failures === 0
    ? '\nRESULT: OK — video timing, series grouping and lazy grid rules hold.\n'
    : `\nRESULT: ${failures} FAILURE(S)\n`,
);
process.exit(failures === 0 ? 0 : 1);
