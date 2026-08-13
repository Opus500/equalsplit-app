// Prove the progression grouping + axis rules before any chart is drawn.
//
//   node scripts/verify-progression.mjs
//
// Imports src/roster/progression.ts directly (Node 24 strips TS types natively), so
// it exercises the real rules. Zero dependencies.

import {
  MIN_SERIES_RUNS,
  MIN_Y_SPAN_MS,
  buildProgression,
  formatDelta,
  seriesTitle,
  xFraction,
  yBounds,
  yFraction,
  yTicks,
} from '../src/roster/progression.ts';

let failures = 0;
const check = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n         got  ${g}\n         want ${w}`}`);
};
const near = (label, got, want, tol = 1e-6) => {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n         got  ${got}\n         want ~${want}`}`);
};
const truthy = (label, got) => check(label, !!got, true);

const DAY = 86400000;
const T0 = Date.UTC(2026, 0, 5);
let seq = 0;
const run = (drillId, drillName, elapsedMs, dayOffset) => ({
  id: `r${++seq}`,
  drillId,
  drillName,
  elapsedMs,
  createdAt: T0 + dayOffset * DAY,
});

console.log('\n1. two drill types NEVER share a series  (the whole point)');
{
  const p = buildProgression([
    run('d30', '30m', 4200, 0),
    run('d40', '40yd dash', 5100, 0),
    run('d30', '30m', 4150, 1),
    run('d40', '40yd dash', 5050, 1),
    run('d30', '30m', 4100, 2),
    run('d40', '40yd dash', 5000, 2),
  ]);
  check('two series, not one', p.series.length, 2);
  check(
    'no series contains a foreign time',
    p.series.map((s) => s.points.every((pt) => (s.drillId === 'd30' ? pt.elapsedMs < 5000 : pt.elapsedMs >= 5000))),
    [true, true],
  );
  const combinedSpan = 5100 - 4100;
  const perSeriesSpans = p.series.map((s) => s.worstMs - s.bestMs);
  console.log(
    `       (one shared axis would span ${combinedSpan}ms; the real signals are ${perSeriesSpans.join('ms and ')}ms — swamped)`,
  );
}

console.log('\n2. grouping is by drill RECORD, not by label text');
{
  // Two records that happen to carry the same name stay separate: the id is the
  // identity. (The v3 migration folds case/padding variants, so this is the
  // deliberate-duplicate case, not the typo case.)
  const p = buildProgression([
    run('dA', 'Sled push', 4000, 0),
    run('dB', 'Sled push', 9000, 1),
    run('dA', 'Sled push', 3900, 2),
  ]);
  check('kept as two series', p.series.length, 2);
  check('and a renamed record still groups its history', p.series[0].points.length, 2);
}

console.log('\n3. unlabeled runs are counted but never charted');
{
  const p = buildProgression([
    run('d30', '30m', 4200, 0),
    run(null, null, 4300, 1), // no drill record
    run(null, null, 9900, 2), // a 40yd, untagged — bucketing these together would MIX
    run('d30', '30m', 4100, 3),
    run('d30', '30m', 4050, 4),
  ]);
  check('unlabeled excluded from every series', p.series.reduce((n, s) => n + s.points.length, 0), 3);
  check('but reported, not silently dropped', p.unlabeledRuns, 2);
  check('total is the honest denominator', p.totalRuns, 5);
  console.log('       (an "untagged" bucket would have put a 4.1s and a 9.9s on one axis)');
}

console.log('\n4. unusable elapsed values are rejected, not charted as zero');
{
  const p = buildProgression([
    run('d30', '30m', 4200, 0),
    run('d30', '30m', 0, 1),
    run('d30', '30m', -5, 2),
    run('d30', '30m', NaN, 3),
    run('d30', '30m', Infinity, 4),
    run('d30', '30m', 4100, 5),
  ]);
  check('only real times charted', p.series[0].points.length, 2);
  check('rejects counted', p.invalidRuns, 4);
  truthy('no NaN reached the stats', Number.isFinite(p.series[0].bestMs));
}

console.log(`\n5. below ${MIN_SERIES_RUNS} runs: no graph, but the numbers still stand`);
{
  // Derived from MIN_SERIES_RUNS, not hard-coded: the threshold is a product
  // decision that has already moved once (3 -> 2), and a test that restates the
  // number rather than reading it starts asserting the old policy the day it changes.
  const seriesOf = (count) =>
    buildProgression(
      Array.from({ length: count }, (_, i) => run('d30', '30m', 4200 - i * 100, i)),
    );

  if (MIN_SERIES_RUNS > 1) {
    const under = seriesOf(MIN_SERIES_RUNS - 1);
    check(`${MIN_SERIES_RUNS - 1} run(s): not graphable`, under.series[0].graphable, false);
    check('nothing anywhere is graphable', under.hasGraphable, false);
    check('best is still correct', under.series[0].bestMs, 4200 - (MIN_SERIES_RUNS - 2) * 100);
  }

  const at = seriesOf(MIN_SERIES_RUNS);
  check(`exactly ${MIN_SERIES_RUNS} runs IS graphable`, at.series[0].graphable, true);
  check('and the screen knows it has something to draw', at.hasGraphable, true);

  const over = seriesOf(MIN_SERIES_RUNS + 3);
  check('comfortably above the threshold too', over.series[0].graphable, true);

  // Stats are computed regardless of whether a chart is drawn.
  const two = buildProgression([run('d30', '30m', 4200, 0), run('d30', '30m', 4100, 1)]);
  check('best of a two-run series', two.series[0].bestMs, 4100);
  check('delta of a two-run series', two.series[0].deltaMs, -100);
}

console.log('\n6. personal best = fastest, and a MATCHED best is still a best');
{
  const p = buildProgression([
    run('d30', '30m', 4200, 0),
    run('d30', '30m', 4000, 1),
    run('d30', '30m', 4300, 2),
    run('d30', '30m', 4000, 3), // equalled it
  ]);
  check('best is the minimum', p.series[0].bestMs, 4000);
  check('both PB runs flagged', p.series[0].points.map((pt) => pt.isBest), [false, true, false, true]);
}

console.log('\n7. points are chronological however they arrive, and deterministically');
{
  const p = buildProgression([
    run('d30', '30m', 4000, 5),
    run('d30', '30m', 4300, 1),
    run('d30', '30m', 4100, 3),
  ]);
  check('sorted oldest -> newest', p.series[0].points.map((pt) => pt.elapsedMs), [4300, 4100, 4000]);
  check('first/latest follow the sort, not input order', [p.series[0].firstMs, p.series[0].latestMs], [4300, 4000]);

  // Same timestamp: id breaks the tie so the chart can't reshuffle between renders.
  const tied = buildProgression([
    { id: 'rB', drillId: 'd', drillName: 'x', elapsedMs: 200, createdAt: T0 },
    { id: 'rA', drillId: 'd', drillName: 'x', elapsedMs: 100, createdAt: T0 },
    { id: 'rC', drillId: 'd', drillName: 'x', elapsedMs: 300, createdAt: T0 },
  ]);
  check('ties order by id, stable across renders', tied.series[0].points.map((pt) => pt.runId), ['rA', 'rB', 'rC']);
}

console.log('\n8. improvement reads as NEGATIVE (faster), in both delta and slope');
{
  const better = buildProgression([
    run('d30', '30m', 4400, 0),
    run('d30', '30m', 4300, 1),
    run('d30', '30m', 4200, 2),
    run('d30', '30m', 4100, 3),
  ]);
  check('delta negative', better.series[0].deltaMs, -300);
  near('slope is -100ms per run', better.series[0].slopeMsPerRun, -100);
  check('and it is worded, not just signed', formatDelta(better.series[0].deltaMs), '0.30s faster');

  const worse = buildProgression([
    run('d30', '30m', 4100, 0),
    run('d30', '30m', 4200, 1),
    run('d30', '30m', 4300, 2),
  ]);
  truthy('regression reads positive', worse.series[0].slopeMsPerRun > 0);
  check('worded as slower', formatDelta(worse.series[0].deltaMs), '0.20s slower');
  check('a trivial change is not spun as progress', formatDelta(3), 'no change');
}

console.log('\n9. the y-axis is NEVER zero-based');
{
  const p = buildProgression([
    run('d30', '30m', 4200, 0),
    run('d30', '30m', 4150, 1),
    run('d30', '30m', 4100, 2),
  ]);
  const b = yBounds(p.series[0]);
  truthy('axis starts well above zero', b.min > 3000);
  truthy('data sits inside the frame', b.min < 4100 && b.max > 4200);
  const zeroBasedUse = (4200 - 4100) / 4200;
  console.log(
    `       (zero-based, this athlete's whole 100ms improvement would occupy ${(zeroBasedUse * 100).toFixed(1)}% of the plot height)`,
  );
}

console.log(`\n10. a flat athlete does not get a fake-drama chart (min span ${MIN_Y_SPAN_MS}ms)`);
{
  const p = buildProgression([
    run('d30', '30m', 4200, 0),
    run('d30', '30m', 4210, 1),
    run('d30', '30m', 4205, 2),
  ]);
  const b = yBounds(p.series[0]);
  truthy('span widened to the floor', b.max - b.min >= MIN_Y_SPAN_MS);
  const spread = yFraction(4200, b.min, b.max) - yFraction(4210, b.min, b.max);
  truthy('so a 10ms wobble stays a small wobble', Math.abs(spread) < 0.1);

  const identical = buildProgression([
    run('d30', '30m', 4200, 0),
    run('d30', '30m', 4200, 1),
    run('d30', '30m', 4200, 2),
  ]);
  const ib = yBounds(identical.series[0]);
  truthy('identical times produce a finite axis', Number.isFinite(ib.min) && Number.isFinite(ib.max));
  truthy('with real height (no divide-by-zero)', ib.max - ib.min >= MIN_Y_SPAN_MS);
  near('and the flat line sits mid-plot', yFraction(4200, ib.min, ib.max), 0.5, 1e-9);
}

console.log('\n11. axis ticks are readable numbers inside the frame');
{
  const b = { min: 4037, max: 4263 };
  const ticks = yTicks(b.min, b.max, 4);
  truthy('at least two ticks', ticks.length >= 2);
  truthy('all inside the frame', ticks.every((t) => t >= b.min - 1e-6 && t <= b.max + 1e-6));
  truthy('all round numbers', ticks.every((t) => Math.abs(t / 50 - Math.round(t / 50)) < 1e-6));
  check('no float drift in the labels', ticks.map((t) => Math.round(t)), ticks.map((t) => t));
  console.log(`       (ticks: ${ticks.map((t) => (t / 1000).toFixed(2)).join('s, ')}s)`);

  // The regression that motivated picking by tick COUNT: rounding 75ms up to 100
  // drew two gridlines on this range, which looks like a broken axis.
  truthy('a narrow range still gets a populated axis', ticks.length >= 3);

  // Across the ranges these charts actually produce, the axis is never degenerate.
  for (const [lo, hi] of [
    [MIN_Y_SPAN_MS * 0.9, MIN_Y_SPAN_MS * 0.9 + MIN_Y_SPAN_MS],
    [3980, 4420],
    [10_400, 12_600],
    [1200, 1240],
  ]) {
    const t = yTicks(lo, hi, 4);
    truthy(
      `range ${(lo / 1000).toFixed(2)}s-${(hi / 1000).toFixed(2)}s => ${t.length} ticks, all in frame`,
      t.length >= 2 && t.length <= 9 && t.every((v) => v >= lo - 1e-6 && v <= hi + 1e-6),
    );
  }
}

console.log('\n12. plot geometry: the y-axis is TIME, so improvement FALLS');
{
  // 0 = top of the plot. Time increases upward, so the SLOWEST time is highest.
  const b = { min: 4000, max: 4400 };
  near('slowest time pins to the top', yFraction(4400, b.min, b.max), 0);
  near('fastest time pins to the bottom', yFraction(4000, b.min, b.max), 1);
  near('midpoint is mid-plot', yFraction(4200, b.min, b.max), 0.5);
  truthy('values past the frame clamp instead of overflowing', yFraction(9999, b.min, b.max) === 0);
  truthy('and clamp at the other end too', yFraction(1, b.min, b.max) === 1);

  // THE invariant, stated in terms of what a coach sees rather than of coordinates.
  // The checks above are all satisfied by an inverted axis if you mislabel them, so
  // this is the one that actually pins the direction.
  const improving = buildProgression([
    run('d30', '30m', 4400, 0),
    run('d30', '30m', 4200, 1),
    run('d30', '30m', 4000, 2),
  ]).series[0];
  const ib = yBounds(improving);
  const screenY = improving.points.map((pt) => yFraction(pt.elapsedMs, ib.min, ib.max));
  truthy('an improving athlete draws a line that goes DOWN the screen', screenY[2] > screenY[0]);
  truthy('and monotonically so', screenY[0] < screenY[1] && screenY[1] < screenY[2]);

  const regressing = buildProgression([
    run('d30', '30m', 4000, 0),
    run('d30', '30m', 4200, 1),
    run('d30', '30m', 4400, 2),
  ]).series[0];
  const rb = yBounds(regressing);
  const rY = regressing.points.map((pt) => yFraction(pt.elapsedMs, rb.min, rb.max));
  truthy('a regressing athlete draws a line that goes UP', rY[2] < rY[0]);

  // The PB is the LOWEST point on screen, not the highest.
  const bestIdx = improving.points.findIndex((pt) => pt.isBest);
  truthy('the PB sits at the bottom of the plot', screenY[bestIdx] === Math.max(...screenY));

  near('first point is flush left', xFraction(0, 4), 0);
  near('last point is flush right', xFraction(3, 4), 1);
  near('a lone point is centred, not stuck at the edge', xFraction(0, 1), 0.5);
}

console.log('\n13. series order puts what they are working on first');
{
  const p = buildProgression([
    run('dOld', '40yd dash', 5000, 0),
    run('dOld', '40yd dash', 4900, 1),
    run('dOld', '40yd dash', 4800, 2),
    run('dNew', '30m', 4200, 40),
    run('dNew', '30m', 4100, 41),
    run('dNew', '30m', 4000, 42),
    run('dThin', 'L Drill', 7000, 45), // recent but only one run
  ]);
  check('graphable series come first', p.series.map((s) => s.graphable), [true, true, false]);
  check('and among them, most recent first', p.series[0].drillName, '30m');
  check('the thin series is last but still listed', p.series[2].drillName, 'L Drill');
}

console.log('\n14. degenerate inputs');
{
  const empty = buildProgression([]);
  check('no runs => no series', empty.series, []);
  check('and nothing to draw', empty.hasGraphable, false);

  const one = buildProgression([run('d30', '30m', 4200, 0)]);
  check('a single run makes a series', one.series.length, 1);
  check('not graphable', one.series[0].graphable, false);
  check('delta of one run is zero, not NaN', one.series[0].deltaMs, 0);
  check('slope of one run is zero, not NaN', one.series[0].slopeMsPerRun, 0);

  const noName = buildProgression([
    { id: 'x1', drillId: 'd', drillName: null, elapsedMs: 100, createdAt: T0 },
  ]);
  check('a nameless record still labels the series', noName.series[0].drillName, 'Untitled drill');

  const allUnlabeled = buildProgression([run(null, null, 4200, 0), run(null, null, 4100, 1)]);
  check('all-unlabeled => no series at all', allUnlabeled.series, []);
  check('but the count explains why the screen is empty', allUnlabeled.unlabeledRuns, 2);
}

console.log('\n15. a video run never shares a series with a gate run');
{
  // Same drill, same athlete, same distance — but a gate fires on the first thing
  // through the beam while a coach marks the torso. That is a systematic offset in
  // one direction, so a merged series would show a step change on the day they
  // switched tools and read it as a performance change.
  const run = (id, at, ms, timeSource) => ({
    id,
    drillId: 'd30',
    drillName: '30m',
    elapsedMs: ms,
    createdAt: at,
    timeSource,
  });
  const p = buildProgression([
    run('g1', 1, 4200, 'gate'),
    run('g2', 2, 4150, 'gate'),
    run('g3', 3, 4180, 'gate'),
    run('v1', 4, 4400, 'video'),
    run('v2', 5, 4380, 'video'),
  ]);
  check('one drill, two sources, two series', p.series.length, 2);

  const gate = p.series.find((s) => s.timeSource === 'gate');
  const video = p.series.find((s) => s.timeSource === 'video');
  check('the gate series holds only gate runs', gate.points.map((x) => x.runId), ['g1', 'g2', 'g3']);
  check('the video series holds only video runs', video.points.map((x) => x.runId), ['v1', 'v2']);
  check('they share a drill id', gate.drillId, video.drillId);

  // The bias must not reach the stats. A merged series would have called the video
  // runs a 0.2s decline; split, each series is judged against its own kind.
  check('the gate best is a gate time', gate.bestMs, 4150);
  check('and the video best is a video time', video.bestMs, 4380);

  // Naming: gate reads exactly as it always did, so no existing chart changes.
  check('a gate series is untitled by source', seriesTitle(gate), '30m');
  check('a video series says so', seriesTitle(video), '30m · video');

  // Absent source folds to gate rather than making a third bucket.
  const legacy = buildProgression([
    { id: 'a', drillId: 'd30', drillName: '30m', elapsedMs: 4200, createdAt: 1 },
    { id: 'b', drillId: 'd30', drillName: '30m', elapsedMs: 4100, createdAt: 2, timeSource: null },
    run('g9', 3, 4300, 'gate'),
  ]);
  check('unknown and explicit gate are ONE series', legacy.series.length, 1);
  check('holding all three', legacy.series[0].points.length, 3);
  check('titled as it always was', seriesTitle(legacy.series[0]), '30m');

  // A hand start carries ~200ms of reaction error — the same argument as video.
  const hand = buildProgression([run('h1', 1, 64000, 'hand'), run('h2', 2, 65000, 'hand'), run('g1', 3, 4200, 'gate')]);
  check('hand-started runs split too', hand.series.length, 2);
  check('and are labelled', seriesTitle(hand.series.find((s) => s.timeSource === 'hand')), '30m · hand start');
}

console.log('\n16. runs with no drill are LISTED but never a series');
{
  // The no-mixing rule protects the AXIS. A 10m and a 40yd sharing a y-axis would
  // draw a line that means nothing, so they still form no series — but they are
  // real runs that need playing, annotating and deleting, and a LIST has no axis.
  const p = buildProgression([
    { id: 'u1', drillId: null, drillName: null, elapsedMs: 4200, createdAt: 10 },
    { id: 'u2', drillId: null, drillName: null, elapsedMs: 9900, createdAt: 20 },
    { id: 'd1', drillId: 'd30', drillName: '30m', elapsedMs: 4300, createdAt: 30 },
  ]);
  check('they form no series', p.series.length, 1);
  check('and the one series is the labelled drill', p.series[0].drillId, 'd30');
  check('but they are handed over for listing', p.unlabeled.length, 2);
  check('the count still agrees', p.unlabeledRuns, 2);

  // Newest first, like every other run list.
  check('newest first', p.unlabeled.map((x) => x.runId), ['u2', 'u1']);

  // THE CLAIM THAT MUST NOT BE MADE. A "personal best" across mixed distances is
  // not a fact — 4.2s and 9.9s are not the same event — and marking one would be
  // exactly the comparison the grouping rule forbids.
  check('no run among them is marked a PB', p.unlabeled.filter((x) => x.isBest).length, 0);

  // Everything the list needs travels with them.
  const withVideo = buildProgression([
    { id: 'u1', drillId: null, drillName: null, elapsedMs: 4200, createdAt: 1, clipId: 'c9', userNote: 'windy' },
  ]);
  check('the clip survives', withVideo.unlabeled[0].clipId, 'c9');
  check('and the note', withVideo.unlabeled[0].userNote, 'windy');

  // Assigning a drill moves the run: same input with a drillId, and it is gone
  // from unlabeled and present in a series. This is what the screen relies on to
  // reflect an assignment without reloading.
  const after = buildProgression([
    { id: 'u1', drillId: 'd30', drillName: '30m', elapsedMs: 4200, createdAt: 10 },
    { id: 'u2', drillId: null, drillName: null, elapsedMs: 9900, createdAt: 20 },
  ]);
  check('the assigned run left the unlabelled list', after.unlabeled.map((x) => x.runId), ['u2']);
  check('and joined a real series', after.series[0].points.map((x) => x.runId), ['u1']);

  check('no unlabelled runs means an empty list, not a phantom page', buildProgression([]).unlabeled, []);
}

console.log('\n=============================');
console.log(failures === 0 ? 'RESULT: OK — progression grouping and axis rules hold.' : `RESULT: ${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
