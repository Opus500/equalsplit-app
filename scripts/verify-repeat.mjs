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
  mergeCrossing,
  parseRepSetJson,
  savedChartValueMs,
  suspectIntervals,
  summarize,
  targetStatus,
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

console.log('\n10. CONTINUOUS: repairing a walk-back removes a BOUNDARY, not time');
{
  // Athlete finishes lap 1 at 62, drifts back through at 66, finishes lap 2 at 130.
  const e = new RepeatEngine(REPEAT_CONTINUOUS);
  e.arm(0);
  e.ingest(brk(0), 0);
  e.ingest(brk(62_000_000), 62_000);
  e.ingest(brk(66_000_000), 66_000); // walked back through
  e.ingest(brk(130_000_000), 130_000);
  const raw = e.end(140_000);
  check('the junk crossing IS collected', raw.intervals.map((i) => i.ms), [62_000, 4_000, 64_000]);
  console.log('       (a 1s lockout cannot catch a walk-back 4s later — that is what the list is for)');

  // Deleting the 4.0s interval would claim a 126s 1200m nobody ran: the athlete
  // was running for all 130s. Removing the BOUNDARY at t=66 is the truth.
  const fixed = mergeCrossing(raw, 1);
  check('lap 2 absorbs the stray split', fixed.intervals.map((i) => i.ms), [62_000, 68_000]);
  check('TOTAL IS UNCHANGED — the run really took this long', fixed.totalMs, raw.totalMs);
  check('and that total is the real 1200m time', fixed.totalMs, 130_000);
  check('mean recomputed off two laps', fixed.meanMs, 65_000);
  check('the original set is untouched', raw.intervals.length, 3);
}

console.log('\n10b. INVARIANT: removing an interior boundary never changes the total');
{
  const e = new RepeatEngine(REPEAT_CONTINUOUS);
  e.arm(0);
  const at = [0, 61_000_000, 65_000_000, 129_000_000, 133_000_000, 196_000_000];
  at.forEach((us, i) => e.ingest(brk(us), Math.round(us / 1000)));
  const set = e.end(200_000);
  check('five intervals', set.intervals.length, 5);

  // Exhaustive over every interior boundary.
  let drift = 0;
  let lost = 0;
  for (let b = 0; b < set.intervals.length - 1; b++) {
    const m = mergeCrossing(set, b);
    if (m.totalMs !== set.totalMs) drift++;
    if (m.intervals.length !== set.intervals.length - 1) lost++;
  }
  check('no boundary removal changed the total', drift, 0);
  check('each removed exactly one boundary', lost, 0);

  // Repeated merges still hold it.
  const twice = mergeCrossing(mergeCrossing(set, 1), 1);
  check('two merges, total still intact', twice.totalMs, set.totalMs);
  check('down to three intervals', twice.intervals.length, 3);

  check('merging past the end is inert', mergeCrossing(set, 4), set);
  check('a negative boundary is inert', mergeCrossing(set, -1), set);
}

console.log('\n10c. the LAST crossing is the one case where the total SHOULD drop');
{
  // Walk-back AFTER the final lap: the run really ended at the previous crossing.
  const e = new RepeatEngine(REPEAT_CONTINUOUS);
  e.arm(0);
  e.ingest(brk(0), 0);
  e.ingest(brk(62_000_000), 62_000);
  e.ingest(brk(130_000_000), 130_000);
  e.ingest(brk(134_000_000), 134_000); // stepped back through after finishing
  const set = e.end(140_000);
  check('collected with the trailing junk', set.intervals.map((i) => i.ms), [62_000, 68_000, 4_000]);

  const fixed = dropInterval(set, 2);
  check('truncated to the real finish', fixed.intervals.map((i) => i.ms), [62_000, 68_000]);
  check('and the total DROPS, correctly', fixed.totalMs, 130_000);
  console.log('       (time after the real finish is not part of the run — the only honest shortening)');
}

console.log('\n10d. an interior DELETE is refused for CONTINUOUS');
{
  const e = new RepeatEngine(REPEAT_CONTINUOUS);
  e.arm(0);
  e.ingest(brk(0), 0);
  e.ingest(brk(62_000_000), 62_000);
  e.ingest(brk(66_000_000), 66_000);
  e.ingest(brk(130_000_000), 130_000);
  const set = e.end(140_000);
  check('deleting an interior interval is a no-op', dropInterval(set, 1), set);
  check('so the total can never be silently shortened', dropInterval(set, 0).totalMs, set.totalMs);
  console.log('       (enforced here, not remembered at the call site)');
}

console.log('\n10e. REST is NOT chained — delete is correct and merge is refused');
{
  const e = new RepeatEngine(REPEAT_REST);
  e.arm(0);
  e.startRep(0);
  e.ingest(brk(64_000_000), 64_000); // 64.0
  e.startRep(200_000);
  e.ingest(brk(203_000_000), 203_000); // 3.0 — junk crossing closed the rep early
  e.startRep(400_000);
  e.ingest(brk(465_000_000), 465_000); // 65.0
  const set = e.end(500_000);
  check('three splits', set.intervals.map((i) => i.ms), [64_000, 3_000, 65_000]);

  const fixed = dropInterval(set, 1);
  check('the junk split is genuinely deleted', fixed.intervals.map((i) => i.ms), [64_000, 65_000]);
  check('and the total drops, correctly', fixed.totalMs, 129_000);
  console.log('       (rest sits between reps and is untimed, so there is no elapsed time to preserve)');

  check('merging is refused for rest', mergeCrossing(set, 1), set);
  check('dropping to empty is safe', dropInterval(dropInterval(fixed, 1), 0).meanMs, 0);
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

console.log('\n13. SAVED sets chart the same as live ones (storage round-trip)');
{
  // The rule has to survive raw_json, or the graph drifts from what the review
  // screen showed at save time.
  const mk = (engine) => {
    const set = engine.end(999_999);
    const raw = JSON.stringify({
      engine: 'repeat',
      variant: set.variant,
      gateId: set.gateId,
      intervals: set.intervals.map((i) => i.ms),
      lockoutMs: set.lockoutMs,
      exact: set.exact,
    });
    return { set, raw };
  };

  const c = new RepeatEngine(REPEAT_CONTINUOUS);
  c.arm(0);
  c.ingest(brk(0), 0);
  c.ingest(brk(62_000_000), 62_000);
  c.ingest(brk(126_500_000), 126_500);
  c.ingest(brk(193_100_000), 193_100);
  const cont = mk(c);
  check(
    'CONTINUOUS round-trips to the same chart value',
    savedChartValueMs(cont.raw, cont.set.totalMs),
    chartValueMs(cont.set),
  );

  const r = new RepeatEngine(REPEAT_REST);
  r.arm(0);
  r.startRep(0);
  r.ingest(brk(64_000_000), 64_000);
  r.startRep(300_000);
  r.ingest(brk(365_000_000), 365_000);
  r.startRep(600_000);
  r.ingest(brk(666_500_000), 666_500);
  const rest = mk(r);
  check(
    'REST round-trips to the same chart value',
    savedChartValueMs(rest.raw, rest.set.totalMs),
    chartValueMs(rest.set),
  );
  truthy('and it is still the mean, not the total', savedChartValueMs(rest.raw, rest.set.totalMs) !== rest.set.totalMs);

  check('the intervals survive for the History expansion', parseRepSetJson(rest.raw).intervals, [
    64_000, 65_000, 66_500,
  ]);

  // A chart must never throw on one bad row.
  check('a non-rep run is not a rep set', savedChartValueMs('{"engine":"v2"}', 4200), null);
  check('null raw_json', savedChartValueMs(null, 4200), null);
  check('malformed JSON', savedChartValueMs('{not json', 4200), null);
  check('rep set with no intervals falls back to the total', savedChartValueMs('{"engine":"repeat","variant":"rest","intervals":[]}', 4200), 4200);
  check('garbage intervals are filtered', parseRepSetJson('{"engine":"repeat","intervals":[1,"x",null,2]}').intervals, [1, 2]);
}

console.log('\n14. LAP TARGET is a target, NOT a terminal condition');
{
  // The whole point: hitting the count must not end anything. A junk crossing
  // would otherwise end the set after two real laps, and every lap the athlete
  // ran afterwards would never be captured at all — the review list can drop an
  // interval, it cannot invent one that was never recorded.
  const e = new RepeatEngine(REPEAT_CONTINUOUS);
  e.arm(0, 3);
  e.ingest(brk(0), 0); // t0
  e.ingest(brk(62_000_000), 62_000); // lap 1
  e.ingest(brk(66_000_000), 66_000); // JUNK: walked back through
  e.ingest(brk(130_000_000), 130_000); // lap 2
  check('the set is STILL running at the target count', e.state, 'running');
  e.ingest(brk(195_000_000), 195_000); // lap 3 — captured because nothing auto-ended
  const set = e.end(200_000);

  check('every crossing was captured', set.intervals.length, 4);
  console.log('       (auto-ending at 3 would have stopped before the real lap 3 — unrecoverable)');

  const st = targetStatus(set);
  check('target carried through', st.target, 3);
  check('actual', st.actual, 4);
  check('one too many — flagged, not fixed', st.excess, 1);

  // The coach removes the stray BOUNDARY and the count matches. (Deleting the
  // 4.0s split is refused here — see 10d — because the athlete ran that time.)
  const fixed = mergeCrossing(set, 1);
  check('after joining, the count matches', targetStatus(fixed).excess, 0);
  check('and the laps are the real ones', fixed.intervals.map((i) => i.ms), [62_000, 68_000, 65_000]);
  check('with the total untouched', fixed.totalMs, set.totalMs);
}

console.log('\n15. no target => behaves exactly as before, with no flagging');
{
  const e = new RepeatEngine(REPEAT_CONTINUOUS);
  e.arm(0); // no count given
  e.ingest(brk(0), 0);
  e.ingest(brk(62_000_000), 62_000);
  e.ingest(brk(126_000_000), 126_000);
  const set = e.end(130_000);
  check('no target stored', set.targetLaps, null);
  const st = targetStatus(set);
  check('nothing flagged', [st.target, st.excess, st.short], [null, 0, 0]);

  // A zero or negative count is the same as not setting one.
  const z = new RepeatEngine(REPEAT_CONTINUOUS);
  z.arm(0, 0);
  check('zero is no target', z.end(1).targetLaps, null);
  const n = new RepeatEngine(REPEAT_CONTINUOUS);
  n.arm(0, -2);
  check('negative is no target', n.end(1).targetLaps, null);
}

console.log('\n16. a SHORT set is reported but never blocked');
{
  const e = new RepeatEngine(REPEAT_REST);
  e.arm(0, 3);
  e.startRep(0);
  e.ingest(brk(64_000_000), 64_000);
  e.startRep(300_000); // athlete pulls up after rep 2 is started
  const set = e.end(400_000);
  const st = targetStatus(set);
  check('one rep recorded', st.actual, 1);
  check('two short', st.short, 2);
  check('but nothing is excess', st.excess, 0);
  console.log('       (a short set really happened — refusing to save it would lose the rep that did)');
}

console.log('\n17. SUSPECT hint points at the walk-back, without dropping it');
{
  const e = new RepeatEngine(REPEAT_CONTINUOUS);
  e.arm(0, 3);
  e.ingest(brk(0), 0);
  e.ingest(brk(62_000_000), 62_000); // 62.0
  e.ingest(brk(66_000_000), 66_000); // 4.0 — the walk-back
  e.ingest(brk(130_000_000), 130_000); // 64.0
  e.ingest(brk(195_000_000), 195_000); // 65.0
  const set = e.end(200_000);
  check('the short one is flagged', suspectIntervals(set), [1]);
  check('and it is still in the set', set.intervals.length, 4);

  // A clean set flags nothing, including one with a genuinely quick last lap.
  const clean = new RepeatEngine(REPEAT_CONTINUOUS);
  clean.arm(0, 3);
  clean.ingest(brk(0), 0);
  clean.ingest(brk(66_000_000), 66_000);
  clean.ingest(brk(130_000_000), 130_000);
  clean.ingest(brk(188_000_000), 188_000); // 58s — a fast finish, not junk
  check('a fast last lap is NOT flagged', suspectIntervals(clean.end(190_000)), []);

  // Too few intervals to have a reliable median: hint nothing rather than guess.
  const two = new RepeatEngine(REPEAT_CONTINUOUS);
  two.arm(0, 1);
  two.ingest(brk(0), 0);
  two.ingest(brk(62_000_000), 62_000);
  two.ingest(brk(66_000_000), 66_000);
  check('under three intervals, no hint', suspectIntervals(two.end(70_000)), []);
}

console.log('\n18. FRAME ACCOUNTING makes a rejection visible instead of silent');
{
  // This block exists because a shipped bug was invisible: every rest crossing
  // was swallowed and nothing anywhere said so. The pure tests all passed,
  // because they fed one consistent clock — only the WIRING mixed two. So the
  // engine now counts why a frame was dropped, and the count is on screen.
  const e = new RepeatEngine(REPEAT_REST);
  e.arm(0, null);
  check('a fresh set starts with a clean tally', e.diag, {
    beam: 0,
    clears: 0,
    otherGate: 0,
    notRunning: 0,
    lockedOut: 0,
    opened: 0,
    accepted: 0,
    lastRejectMs: null,
  });

  // Nothing arriving vs arriving-and-rejected: the first counter separates them.
  e.ingest(clr(1_000_000), 1_000); // a clear
  e.ingest(brk(1_000_000, 2), 1_000); // the other gate
  e.ingest(brk(2_000_000), 2_000); // right gate, but no tap yet
  check('beam frames were seen', e.diag.beam, 3);
  check('and each was attributed', [e.diag.clears, e.diag.otherGate, e.diag.notRunning], [1, 1, 1]);
  check('none became an interval', e.diag.accepted, 0);

  e.startRep(10_000);
  check('the tap is counted as an open', e.diag.opened, 1);
  e.ingest(brk(10_500_000), 10_500); // inside the 1s lockout
  check('locked out', e.diag.lockedOut, 1);
  check('and the dt is reported', e.diag.lastRejectMs, 500);

  e.ingest(brk(74_000_000), 74_000);
  check('a good crossing is accepted', e.diag.accepted, 1);

  // THE SHIPPED BUG, reproduced: a tap stamped on the wall clock against a frame
  // stamped on the monotonic one. The engine cannot know, but it must SAY so.
  const wrong = new RepeatEngine(REPEAT_REST);
  wrong.arm(0);
  wrong.startRep(Date.now()); // epoch ms — the mistake
  wrong.ingest(brk(74_000_000), 74_000); // perfNow ms — what frames carry
  check('the crossing is rejected, as it was on device', wrong.diag.accepted, 0);
  check('by the lockout', wrong.diag.lockedOut, 1);
  truthy(
    'and lastRejectMs is unmistakably a clock mismatch, not a long lockout',
    wrong.diag.lastRejectMs < -60_000,
  );
  console.log(
    `       (lastRejectMs ${wrong.diag.lastRejectMs}ms — no lockout is minutes long; that is two clocks)`,
  );
}

console.log('\n=============================');
console.log(failures === 0 ? 'RESULT: OK — single-gate interval rules hold.' : `RESULT: ${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
