// Prove the single-gate interval rules before any UI or provider wiring exists.
//
//   node scripts/verify-repeat.mjs
//
// Imports src/ble/repeats.ts directly. Zero dependencies. Nothing here touches
// BLE — it feeds the engine the same parsed frames the provider would.

// repeats.ts imports siblings extensionlessly (clockSync, lockout, v2), which
// Node's ESM resolver won't follow — hence the hook, and the dynamic import that
// has to come after it. Same shim the other verify scripts use.
import './_ts-resolve.mjs';

const {
  HAND_START_ERROR_MS,
  REPEAT_CONTINUOUS,
  REPEAT_MODE,
  REPEAT_REST,
  RepeatEngine,
  chartValueMs,
  clampRepeatLockout,
  dropInterval,
  summarize,
} = await import('../src/ble/repeats.ts');

let failures = 0;
const check = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n         got  ${g}\n         want ${w}`}`);
};
const truthy = (label, got) => check(label, !!got, true);

const GATE = 1;
/** A beam BREAK on the timed gate. */
const brk = (micros, gateId = GATE) => ({
  kind: 'beam',
  edge: 'break',
  gateId,
  micros: micros >>> 0,
  flags: 0,
});
const clr = (micros, gateId = GATE) => ({ ...brk(micros, gateId), edge: 'clear' });

const cfg = (base, over = {}) => ({ ...base, ...over });

console.log('\n1. CONTINUOUS: the first crossing is t0 and closes nothing');
{
  const e = new RepeatEngine(REPEAT_CONTINUOUS);
  e.arm(0);
  check('armed, waiting for the line', e.state, 'armed');
  const first = e.ingest(brk(1_000_000), 1000);
  check('first crossing produces no interval', first, null);
  check('an interval is now open', e.state, 'running');
  check('nothing collected yet', e.intervals.length, 0);
}

console.log('\n2. CONTINUOUS: a 1200m is three laps from four crossings');
{
  const e = new RepeatEngine(REPEAT_CONTINUOUS);
  e.arm(0);
  e.ingest(brk(0), 0); // t0
  e.ingest(brk(62_000_000), 62_000); // lap 1: 62.0s
  e.ingest(brk(126_500_000), 126_500); // lap 2: 64.5s
  e.ingest(brk(193_100_000), 193_100); // lap 3: 66.6s
  const set = e.end(200_000);
  check('three laps', set.intervals.length, 3);
  check('lap times', set.intervals.map((i) => i.ms), [62_000, 64_500, 66_600]);
  check('total is the 1200m time', set.totalMs, 193_100);
  check('mean lap', set.meanMs, 64_367);
  check('every interval is gate-timed at both ends', set.intervals.map((i) => i.startSource), [
    'gate',
    'gate',
    'gate',
  ]);
  check('so the set is exact', set.exact, true);
}

console.log('\n3. CONTINUOUS: end() discards the interval still open');
{
  const e = new RepeatEngine(REPEAT_CONTINUOUS);
  e.arm(0);
  e.ingest(brk(0), 0); // t0 — opens lap 1
  e.ingest(brk(60_000_000), 60_000); // closes lap 1, opens lap 2
  const set = e.end(90_000); // pressed mid-lap-2
  check('only the completed lap is kept', set.intervals.length, 1);
  check('and it is the real one', set.intervals[0].ms, 60_000);
  console.log('       (the stretch after the last crossing has no closing crossing — it is not a time)');
}

console.log('\n4. LOCKOUT: one body crossing once is one interval');
{
  const e = new RepeatEngine(cfg(REPEAT_CONTINUOUS, { lockoutMs: 1000 }));
  e.arm(0);
  e.ingest(brk(0), 0); // t0
  // A limb swinging through: several break edges within a few hundred ms.
  e.ingest(brk(60_000_000), 60_000);
  e.ingest(brk(60_120_000), 60_120);
  e.ingest(brk(60_300_000), 60_300);
  e.ingest(brk(60_800_000), 60_800);
  const set = e.end(70_000);
  check('one crossing, one interval', set.intervals.length, 1);
  check('timed to the FIRST edge of the crossing', set.intervals[0].ms, 60_000);
}

console.log('\n5. LOCKOUT: an out-of-order frame is swallowed, not charted as negative');
{
  const e = new RepeatEngine(REPEAT_CONTINUOUS);
  e.arm(0);
  e.ingest(brk(0), 0);
  e.ingest(brk(60_000_000), 60_000);
  const late = e.ingest(brk(59_500_000), 60_100); // arrives after, timestamped before
  check('swallowed', late, null);
  const set = e.end(70_000);
  check('no negative interval reached the set', set.intervals.every((i) => i.ms > 0), true);
  check('still just the one lap', set.intervals.length, 1);
}

console.log('\n6. CONTINUOUS is wrap-safe across the uint32 micros rollover');
{
  const e = new RepeatEngine(REPEAT_CONTINUOUS);
  e.arm(0);
  const beforeWrap = 0xfffff000; // ~4.29e9 us, moments from rollover
  e.ingest(brk(beforeWrap), 0);
  // 62s later, having wrapped through zero.
  const afterWrap = (beforeWrap + 62_000_000) >>> 0;
  truthy('the clock really did wrap', afterWrap < beforeWrap);
  e.ingest(brk(afterWrap), 62_000);
  const set = e.end(70_000);
  check('lap time is correct across the wrap', set.intervals[0].ms, 62_000);
}

console.log('\n7. REST: rest sits OUTSIDE every interval');
{
  const e = new RepeatEngine(REPEAT_REST);
  e.arm(0);
  check('waiting for the coach, not the gate', e.state, 'resting');
  check('a crossing before the tap does nothing', e.ingest(brk(1_000_000), 1_000), null);

  e.startRep(10_000); // tap
  e.ingest(brk(74_000_000), 74_000); // 64.0s rep
  check('back to resting after the crossing', e.state, 'resting');

  // 3 minutes of recovery — during which a stray crossing must not open anything.
  check('a crossing during rest is ignored', e.ingest(brk(120_000_000), 120_000), null);

  e.startRep(254_000); // tap for rep 2
  e.ingest(brk(319_000_000), 319_000); // 65.0s
  e.startRep(500_000);
  e.ingest(brk(566_500_000), 566_500); // 66.5s

  const set = e.end(600_000);
  check('three reps', set.intervals.length, 3);
  check('rep times exclude the rest', set.intervals.map((i) => i.ms), [64_000, 65_000, 66_500]);
  check('every rep is tap-started', set.intervals.map((i) => i.startSource), ['tap', 'tap', 'tap']);
  check('so the set is NOT exact', set.exact, false);
  console.log(`       (each start carries ~${HAND_START_ERROR_MS}ms of reaction — the UI must say so)`);
}

console.log('\n8. REST: end() discards a rep that was started but never finished');
{
  const e = new RepeatEngine(REPEAT_REST);
  e.arm(0);
  e.startRep(1_000);
  e.ingest(brk(65_000_000), 65_000);
  e.startRep(200_000); // athlete pulls up, never crosses
  const set = e.end(260_000);
  check('only the finished rep is kept', set.intervals.length, 1);
  check('and its time is right', set.intervals[0].ms, 64_000);
}

console.log('\n9. THE CHART RULE — the two variants do NOT share one');
{
  const cont = new RepeatEngine(REPEAT_CONTINUOUS);
  cont.arm(0);
  cont.ingest(brk(0), 0);
  cont.ingest(brk(62_000_000), 62_000);
  cont.ingest(brk(126_500_000), 126_500);
  cont.ingest(brk(193_100_000), 193_100);
  const c = cont.end(200_000);
  check('CONTINUOUS charts the TOTAL', chartValueMs(c), c.totalMs);
  check('which is the real 1200m time', chartValueMs(c), 193_100);

  const rest = new RepeatEngine(REPEAT_REST);
  rest.arm(0);
  rest.startRep(0);
  rest.ingest(brk(64_000_000), 64_000);
  rest.startRep(300_000);
  rest.ingest(brk(365_000_000), 365_000);
  rest.startRep(600_000);
  rest.ingest(brk(666_500_000), 666_500);
  const r = rest.end(700_000);
  check('REST charts the MEAN', chartValueMs(r), r.meanMs);
  check('the per-rep number a coach says out loud', chartValueMs(r), 65_167);
  truthy('and NOT the total, which nobody ran', chartValueMs(r) !== r.totalMs);

  // Why the mean, spelled out: a hand-tapped start biases every rep, so a SUM
  // accumulates that error once per rep while the mean does not.
  const reps = r.intervals.length;
  console.log(
    `       (sum would carry ~${HAND_START_ERROR_MS * reps}ms of tap bias across ${reps} reps; the mean ~${HAND_START_ERROR_MS}ms)`,
  );
}

console.log('\n10. Dropping a spurious crossing before saving');
{
  // Athlete finishes a lap, then drifts back through the beam: a junk ~4s interval.
  const e = new RepeatEngine(REPEAT_CONTINUOUS);
  e.arm(0);
  e.ingest(brk(0), 0);
  e.ingest(brk(62_000_000), 62_000);
  e.ingest(brk(66_000_000), 66_000); // walked back through
  e.ingest(brk(130_000_000), 130_000);
  const raw = e.end(140_000);
  check('the junk crossing IS collected', raw.intervals.map((i) => i.ms), [62_000, 4_000, 64_000]);
  console.log('       (a 1s lockout cannot catch a walk-back 4s later — that is what the list is for)');

  const fixed = dropInterval(raw, 1);
  check('dropped', fixed.intervals.map((i) => i.ms), [62_000, 64_000]);
  check('total recomputed', fixed.totalMs, 126_000);
  check('mean recomputed', fixed.meanMs, 63_000);
  check('order preserved', fixed.intervals[0].ms < fixed.intervals[1].ms, true);
  check('the original set is untouched', raw.intervals.length, 3);
  check('an out-of-range index is inert', dropInterval(fixed, 9), fixed);
  check('dropping to empty is safe', dropInterval(dropInterval(fixed, 0), 0).meanMs, 0);
}

console.log('\n11. frames that must not drive the engine');
{
  const e = new RepeatEngine(REPEAT_CONTINUOUS);
  e.arm(0);
  check('a CLEAR does not start a set', e.ingest(clr(1_000_000), 1_000), null);
  check('still armed', e.state, 'armed');
  check('a break on the OTHER gate is ignored', e.ingest(brk(1_000_000, 2), 1_000), null);
  check('still armed after the foreign gate', e.state, 'armed');
  check('a status frame is ignored', e.ingest({ kind: 'status', gateId: 1 }, 1_000), null);
  e.ingest(brk(2_000_000), 2_000); // t0
  check('a CLEAR mid-run closes nothing', e.ingest(clr(70_000_000), 70_000), null);
  check('the second gate stays free for another station', e.ingest(brk(70_000_000, 2), 70_000), null);
  check('no intervals from any of it', e.intervals.length, 0);
}

console.log('\n12. degenerate sets and config guards');
{
  const e = new RepeatEngine(REPEAT_CONTINUOUS);
  e.arm(0);
  const empty = e.end(1_000);
  check('a set with no crossings is empty, not broken', empty.intervals, []);
  check('total 0', empty.totalMs, 0);
  check('mean 0, not NaN', empty.meanMs, 0);

  check('summarize of nothing', summarize([]), { totalMs: 0, meanMs: 0 });

  const e2 = new RepeatEngine(REPEAT_CONTINUOUS);
  e2.arm(0);
  e2.ingest(brk(0), 0);
  e2.setConfig(REPEAT_REST); // mid-set switch
  check('config cannot change mid-set', e2.config.variant, 'continuous');
  e2.reset();
  e2.setConfig(REPEAT_REST);
  check('and can once idle', e2.config.variant, 'rest');

  check('startRep is inert in CONTINUOUS', (() => {
    const c = new RepeatEngine(REPEAT_CONTINUOUS);
    c.arm(0);
    c.startRep(1_000);
    return c.state;
  })(), 'armed');

  check('lockout clamps to bounds', clampRepeatLockout('repeat-rest', 99_999), 60_000);
  check('and up to the floor', clampRepeatLockout('repeat-rest', 10), 500);
  check('rep sets get their own mode', REPEAT_MODE, 4);
}

console.log('\n=============================');
console.log(failures === 0 ? 'RESULT: OK — single-gate interval rules hold.' : `RESULT: ${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
