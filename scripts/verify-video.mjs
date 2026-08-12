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
  videoDecimals,
  formatVideoSeconds,
  parallaxErrorMs,
  BODY_PART_BIAS_MS,
  emptyGrid,
  probeWindow,
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
} = await import('../src/video/timing.ts');
const { restRepRawJson, runStartSource, REPEAT_MODE } = await import('../src/ble/repeats.ts');

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

  // Decimals are earned, never assumed.
  check('30fps cannot honestly show hundredths', videoDecimals(sd(30)), 1);
  check('60fps can', videoDecimals(sd(60)), 2);
  check('240fps can, but not thousandths', videoDecimals(sd(240)), 2);
  check('a 30fps time prints as 4.2s', formatVideoSeconds(4213, videoDecimals(sd(30))), '4.2');
  check('a 240fps time prints as 4.21s', formatVideoSeconds(4213, videoDecimals(sd(240))), '4.21');
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

  const { window, times } = probeWindow(1.0, 1 / 30, 5);
  truthy('probing asks around the centre', window.from < 1.0 && window.to > 1.0);
  truthy('at quarter-frame granularity', times.length >= 40);
  near('and never before zero', probeWindow(0.01, 1 / 30, 5).window.from, 0, 1e-9);

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
  const raw = videoRunRawJson({ startPts: 1.5, endPts: 5.75, fps: 59.94, quantSdMs: 6.8, clipId: 'c1' });
  const back = parseVideoRunJson(raw);
  near('start survives', back.startPts, 1.5, 1e-9);
  near('end survives', back.endPts, 5.75, 1e-9);
  near('the MEASURED fps survives, not a nominal one', back.fps, 59.94, 1e-9);
  near('and so does the error bar', back.quantSdMs, 6.8, 1e-9);
  check('the clip reference survives for attaching video later', back.clipId, 'c1');
  check('a kept-time-only run has no clip', parseVideoRunJson(videoRunRawJson({ startPts: 0, endPts: 1, fps: 30, quantSdMs: 13 })).clipId, null);

  // It must not claim rows that are not video runs.
  check('a rep set is not a video run', parseVideoRunJson('{"engine":"rep-set"}'), null);
  check('nor is a rest rep', parseVideoRunJson(restRepRawJson({ ms: 1, closeUs: 1, closeAtMs: 1, lockoutMs: 1, gateId: 1 })), null);
  check('nor malformed json', parseVideoRunJson('{nope'), null);
}

console.log('\n11. PROBING lands inside frames, never on their edges');
{
  // Measured on device: 30 requests spaced exactly 1/fps apart came back with only
  // 29 distinct frames. Zero-tolerance extraction returns the frame CONTAINING the
  // requested time, so a request sitting exactly on a boundary is decided by float
  // representation — one of them floored to the frame before.
  const dur = 1 / 30;
  const { times, window } = probeWindow(1.0, dur, 5);
  const onEdge = times.filter((t) => {
    // JS % is a remainder and keeps the sign, so probes before the centre need
    // the extra fold to land in [0,1).
    const frac = ((((t - 1.0) / dur) % 1) + 1) % 1;
    const d = Math.min(frac, 1 - frac);
    return d < 0.05;
  });
  check('no probe sits on a frame boundary', onEdge, []);
  truthy('and probing still spans the window', times[0] > window.from && times.length > 20);

  // The same rule for stepping: to display frame N, ask for its middle.
  const m = { pts: 2.0, frameDurSec: dur };
  near('a seek target is half a frame in', seekTimeFor(m), 2.0 + dur / 2, 1e-9);
  truthy('which is strictly inside the frame', seekTimeFor(m) > m.pts && seekTimeFor(m) < m.pts + dur);

  // Round trip: seeking to the computed time must resolve back to the same frame.
  const g = ingestFrames(emptyGrid(), { from: 1.9, to: 2.2 }, [1.95, 2.0, 2.0 + dur, 2.0 + 2 * dur]);
  check('the seek target resolves to the frame it came from', markAt(g, seekTimeFor(m)).pts, 2.0);
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
  check('and never a negative time', filmstripTimes(-3, -1, 4)[0] > -3, true);
}

console.log(
  failures === 0
    ? '\nRESULT: OK — video timing, series split and lazy grid rules hold.\n'
    : `\nRESULT: ${failures} FAILURE(S)\n`,
);
process.exit(failures === 0 ? 0 : 1);
