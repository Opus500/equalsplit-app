// Prove the discard-window rules before any UI is built on them.
//
//   node scripts/verify-pending.mjs
//
// Imports src/runs/pending.ts directly (Node 24 strips TS types natively).
// Zero dependencies.

import {
  EMPTY_PENDING,
  clearReason,
  describe,
  isOpen,
  offer,
  settle,
} from '../src/runs/pending.ts';

let failures = 0;
const check = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n         got  ${g}\n         want ${w}`}`);
};

let t = 1000;
const mkRun = (runId, athleteName, totalMs = 4200, standalone = false) => ({
  runId,
  totalMs,
  athleteName,
  drillName: '30m',
  standalone,
  savedAt: (t += 1000),
});

console.log('\n1. a finished run opens the window, and it STAYS open');
{
  let s = offer(EMPTY_PENDING, mkRun('r1', 'Nadia'));
  check('window open', isOpen(s), true);
  check('pointing at the run just finished', s.pending.runId, 'r1');
  check('nothing has closed yet', s.lastReason, null);
  // There is no tick/expiry function to call at all: the window cannot time out.
  console.log('       (no timer exists in this module — the window has no expiry to test)');
}

console.log('\n2. every close path KEEPS the run; only discard destroys it');
{
  for (const reason of ['next-rep', 'dismissed', 'disconnected', 'backgrounded']) {
    const s = settle(offer(EMPTY_PENDING, mkRun('r1', 'Nadia')), reason);
    check(`${reason}: window closed`, isOpen(s), false);
    check(`${reason}: recorded as why`, s.lastReason, reason);
  }
  const d = settle(offer(EMPTY_PENDING, mkRun('r1', 'Nadia')), 'discarded');
  check('discarded is distinguishable from kept', d.lastReason, 'discarded');
}

console.log('\n3. GUARD: the next rep closes the window on the previous run');
{
  const first = offer(EMPTY_PENDING, mkRun('r1', 'Nadia'));
  const settled = settle(first, 'next-rep');
  check('previous run is no longer discardable here', isOpen(settled), false);
  check('and it was kept, not deleted', settled.lastReason, 'next-rep');
}

console.log('\n4. GUARD: a second run supersedes — window moves to the NEWEST');
{
  const first = offer(EMPTY_PENDING, mkRun('r1', 'Nadia'));
  const second = offer(first, mkRun('r2', 'Marcus'));
  check('window now points at the newer run', second.pending.runId, 'r2');
  check('the first settled rather than being dropped silently', second.lastReason, 'superseded');
  check('exactly one run is pending, never two', isOpen(second), true);

  // The hazard this creates, made explicit: the control must NAME its target,
  // because the run it deletes is no longer the one that was on screen a moment ago.
  check('the control names the run it will delete', describe(second.pending), '4.20s · Marcus · 30m');
  console.log('       (an unlabelled "Discard" here would bin Marcus\'s run while the coach meant Nadia\'s)');
}

console.log('\n5. re-offering the SAME run is idempotent (no phantom supersede)');
{
  const run = mkRun('r1', 'Nadia');
  const once = offer(EMPTY_PENDING, run);
  const twice = offer(once, run);
  check('state is unchanged', twice, once);
  check('and it is not reported as a supersede', twice.lastReason, null);
}

console.log('\n6. standalone (B1) runs never take the window, and never close one');
{
  const solo = offer(EMPTY_PENDING, mkRun('b1', null, 5000, true));
  check('a B1 run alone opens nothing', isOpen(solo), false);

  const open = offer(EMPTY_PENDING, mkRun('r1', 'Nadia'));
  const afterB1 = offer(open, mkRun('b1', null, 5000, true));
  check('an open window is untouched by a B1 run', afterB1.pending.runId, 'r1');
  check('and it was NOT reported as superseded', afterB1.lastReason, null);
  console.log("       (nobody was driving the phone for a B1 run — it is logged, and discarded from History)");
}

console.log('\n7. settling when nothing is pending is inert');
{
  check('no spurious reason appears', settle(EMPTY_PENDING, 'next-rep'), EMPTY_PENDING);
  const closed = settle(offer(EMPTY_PENDING, mkRun('r1', 'Nadia')), 'dismissed');
  check('and settling twice does not overwrite the first reason', settle(closed, 'next-rep').lastReason, 'dismissed');
}

console.log('\n8. the confirmation line can be dismissed without reopening anything');
{
  const closed = settle(offer(EMPTY_PENDING, mkRun('r1', 'Nadia')), 'discarded');
  const cleared = clearReason(closed);
  check('reason gone', cleared.lastReason, null);
  check('window still closed', isOpen(cleared), false);
  check('clearing an already-clear state is a no-op', clearReason(cleared), cleared);
}

console.log('\n9. the label degrades gracefully for an Unassigned or unlabelled run');
{
  check(
    'no athlete: still identifies the run by time',
    describe({ runId: 'x', totalMs: 4213, athleteName: null, drillName: '30m', standalone: false, savedAt: 0 }),
    '4.21s · 30m',
  );
  check(
    'no athlete and no drill: the time alone',
    describe({ runId: 'x', totalMs: 4213, athleteName: null, drillName: null, standalone: false, savedAt: 0 }),
    '4.21s',
  );
}

console.log('\n=============================');
console.log(failures === 0 ? 'RESULT: OK — discard-window rules hold.' : `RESULT: ${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
