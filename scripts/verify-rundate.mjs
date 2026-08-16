// Prove the backdating rules before a date can reshape anyone's chart.
//
//   node scripts/verify-rundate.mjs
//
// Imports src/runs/rundate.ts directly. Zero dependencies.
//
// The claim that matters: a run's date changes its RANK, and rank decides which
// run is first and which is latest — so a mistyped year does not move one point,
// it rewrites the trend for the whole series. Everything here exists to make that
// visible before it is saved rather than mysterious afterwards.

import {
  MAX_BACKDATE_MS,
  dateImpact,
  effectiveRunDate,
  isBackdated,
  localNoon,
  parseDateInput,
  sameLocalDay,
  toDateInput,
} from '../src/runs/rundate.ts';
// The exact wording the alert shows. Asserting the numbers alone would let the
// sign flip be real and the sentence describing it be wrong.
import { formatDelta } from '../src/roster/progression.ts';

let failures = 0;
const check = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `\n         got  ${g}\n         want ${w}`}`);
};
const truthy = (label, v) => check(label, !!v, true);

// LOCAL dates throughout, never Date.UTC: a run is filed under the local calendar
// day, the same rule sessions are named by, so an evening session does not become
// tomorrow's.
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();

console.log('\n1. TWO DATES, and the row keeps both');
{
  const recorded = at(2026, 8, 13);
  const filmed = at(2025, 9, 2);

  check('no performed_at means the run happened when it was recorded', effectiveRunDate(null, recorded), recorded);
  check('undefined the same', effectiveRunDate(undefined, recorded), recorded);
  check('a performed_at wins', effectiveRunDate(filmed, recorded), filmed);
  // Guarding the shape rather than trusting callers: a 0 or a NaN must not become
  // "1 January 1970" on someone's chart.
  check('zero is not a date', effectiveRunDate(0, recorded), recorded);
  check('nor is NaN', effectiveRunDate(NaN, recorded), recorded);
}

console.log('\n2. BACKDATED means a different DAY, not a different millisecond');
{
  const morning = at(2026, 8, 13, 9);
  const evening = at(2026, 8, 13, 21);
  check('filmed and marked the same day is NOT backdated', isBackdated(morning, evening), false);
  console.log('       (otherwise every clip marked after lunch would carry the marker)');

  check('yesterday is', isBackdated(at(2026, 8, 12), at(2026, 8, 13)), true);
  check('last year certainly is', isBackdated(at(2025, 8, 13), at(2026, 8, 13)), true);
  check('and no performed_at is never backdated', isBackdated(null, at(2026, 8, 13)), false);

  // The local-day rule itself, including the case that motivates it.
  truthy('late evening and early morning are different days', !sameLocalDay(at(2026, 8, 13, 23), at(2026, 8, 14, 1)));
  truthy('but 9am and 9pm are the same one', sameLocalDay(at(2026, 8, 13, 9), at(2026, 8, 13, 21)));
}

console.log('\n3. TYPED DATES are rejected, never coerced');
{
  const now = at(2026, 8, 13);
  const ok = parseDateInput('2025-09-02', now);
  check('a real date parses', ok.ok, true);
  check('and lands on that day', toDateInput(ok.at), '2025-09-02');

  // Anchored at NOON so no timezone or DST shift can move the day.
  check('resolved mid-day, not midnight', new Date(ok.at).getHours(), 12);

  // THE ONE new Date() WOULD GET WRONG. It accepts 31 February and hands back
  // 3 March — a silent correction that puts a run on a day nobody chose.
  const feb31 = parseDateInput('2026-02-31', now);
  check('31 February is refused, not rolled forward', feb31.ok, false);
  truthy('and says so plainly', /not a real date/.test(feb31.reason));
  check('while 29 February in a leap year is fine', parseDateInput('2024-02-29', now).ok, true);
  check('and in a non-leap year is not', parseDateInput('2025-02-29', now).ok, false);

  check('month 13 is refused', parseDateInput('2026-13-01', now).ok, false);
  check('day 0 is refused', parseDateInput('2026-08-00', now).ok, false);
  check('free text is refused', parseDateInput('last tuesday', now).ok, false);
  check('an empty field is refused', parseDateInput('', now).ok, false);
  check('and a missing one does not throw', parseDateInput(undefined, now).ok, false);
  check('surrounding space is tolerated', parseDateInput('  2026-08-13 ', now).ok, true);

  // A RUN CANNOT HAVE HAPPENED TOMORROW.
  const future = parseDateInput('2026-08-14', now);
  check('tomorrow is refused', future.ok, false);
  truthy('by name', /future/.test(future.reason));
  check('today is accepted', parseDateInput('2026-08-13', now).ok, true);
  console.log('       (compared on the local DAY, so "today" holds however the clock is set)');

  // THE MISTYPED YEAR, which is the error this whole feature guards against.
  const tooOld = parseDateInput('2015-08-13', now);
  check('a decade ago is refused', tooOld.ok, false);
  truthy('and points at the year, since that is the field most likely wrong', /year/.test(tooOld.reason));
  const edge = parseDateInput(toDateInput(now - MAX_BACKDATE_MS + 86_400_000), now);
  check('just inside five years is allowed', edge.ok, true);
}

console.log('\n4. THE CONSEQUENCE, which is what gets shown instead of the value');
{
  // An athlete improving steadily: 4.40 -> 4.30 -> 4.20 across three sessions.
  const existing = [
    { elapsedMs: 4400, at: at(2026, 6, 1) },
    { elapsedMs: 4300, at: at(2026, 7, 1) },
    { elapsedMs: 4200, at: at(2026, 8, 1) },
  ];

  // TODAY: appended. No reordering, so nothing to warn about.
  const today = dateImpact(existing, { elapsedMs: 4250, at: at(2026, 8, 13) });
  check('a run dated today lands last', [today.rank, today.total], [4, 4]);
  check('and inserts into nothing', today.insertsIntoHistory, false);
  console.log('       (this is the common case and it must stay silent)');

  // THE MISTYPED YEAR. Same run, 2025 instead of 2026.
  const slip = dateImpact(existing, { elapsedMs: 4250, at: at(2025, 8, 13) });
  check('a wrong year lands it first', slip.rank, 1);
  check('which is an insertion, not an append', slip.insertsIntoHistory, true);
  check('and it becomes the earliest run', slip.becomesEarliest, true);

  // THE DAMAGE, stated as a number. Before: 4200-4400 = 0.20s faster. After: the
  // 4250 is now the FIRST run, so the series reads 4200-4250 = 0.05s faster.
  check('the trend before', slip.deltaBeforeMs, -200);
  check('the trend after', slip.deltaAfterMs, -50);
  truthy('so the improvement on record shrinks to a quarter of itself', slip.deltaAfterMs > slip.deltaBeforeMs);
  console.log('       (0.20s faster becomes 0.05s faster — one typo, and the season flattens)');

  // A worse one: a SLOW run backdated to the front turns improvement into decline.
  const flip = dateImpact(
    [
      { elapsedMs: 4200, at: at(2026, 7, 1) },
      { elapsedMs: 4100, at: at(2026, 8, 1) },
    ],
    { elapsedMs: 4000, at: at(2025, 1, 1) },
  );
  check('an old fast run lands first', flip.rank, 1);
  check('turning an improvement', flip.deltaBeforeMs, -100);
  check('into a decline', flip.deltaAfterMs, 100);
  truthy('a sign flip, which is the loudest thing the warning can say', flip.deltaBeforeMs < 0 && flip.deltaAfterMs > 0);

  // Middle insertion still counts as reordering even though it is not the front.
  const mid = dateImpact(existing, { elapsedMs: 4250, at: at(2026, 7, 15) });
  check('a date between two runs inserts', [mid.rank, mid.insertsIntoHistory], [3, true]);
  check('but does not become the earliest', mid.becomesEarliest, false);
  check('and leaves first/latest alone, so the trend is unchanged', mid.deltaAfterMs, mid.deltaBeforeMs);
  console.log('       (reordering is worth saying; it just is not always alarming)');
}

console.log('\n5. degenerate series');
{
  const only = dateImpact([], { elapsedMs: 4200, at: at(2026, 8, 13) });
  check('the first run of a drill ranks 1 of 1', [only.rank, only.total], [1, 1]);
  check('appends rather than inserts', only.insertsIntoHistory, false);
  check('is not "the earliest" — there is nothing to be earlier than', only.becomesEarliest, false);
  check('and has no trend either side', [only.deltaBeforeMs, only.deltaAfterMs], [null, null]);

  const second = dateImpact([{ elapsedMs: 4400, at: at(2026, 8, 1) }], { elapsedMs: 4200, at: at(2026, 8, 13) });
  check('a second run makes a trend where there was none', [second.deltaBeforeMs, second.deltaAfterMs], [null, -200]);

  // Ties: a run dated the same day as an existing one goes AFTER it, matching
  // "it was added later". Deterministic either way, which is what matters.
  const tie = dateImpact([{ elapsedMs: 4400, at: at(2026, 8, 1) }], { elapsedMs: 4200, at: at(2026, 8, 1) });
  check('a tie appends rather than inserting', [tie.rank, tie.insertsIntoHistory], [2, false]);
}

console.log('\n6. RE-DATING A SAVED RUN is a MOVE, not an addition');
{
  // The saved-run editor asks the same question as the marking screen about a run
  // that is ALREADY in the series. Treated as an addition, the arithmetic goes
  // wrong twice over: the run is counted alongside itself, so a series of four
  // reports five; and "before" means a chart with the run deleted, which is a chart
  // the coach has never seen and never will.
  const series = [
    { elapsedMs: 4400, at: at(2025, 3, 1) },
    { elapsedMs: 4300, at: at(2025, 4, 1) },
    { elapsedMs: 4200, at: at(2025, 5, 1) },
  ];
  // The run being moved, currently sitting last at 4100.
  const mine = { elapsedMs: 4100, at: at(2025, 6, 1) };

  const moved = dateImpact(series, { ...mine, at: at(2025, 2, 1) }, { at: mine.at });
  check('the total counts the run once', moved.total, 4);
  check('it lands first', moved.rank, 1);
  check('and it knows where it came from', moved.previousRank, 4);
  check('so it reorders', moved.reorders, true);
  check('and becomes the earliest', moved.becomesEarliest, true);

  // BEFORE is the chart as it stands TODAY — with this run last, 4400 -> 4100, an
  // improvement of 0.30s. Not the chart without it (4400 -> 4200, 0.20s), which is
  // the number an addition-shaped call would report.
  check('before is the trend the coach can currently see', moved.deltaBeforeMs, 4100 - 4400);
  check('after puts the fast run first and the season reads as a decline', moved.deltaAfterMs, 4200 - 4100);
  truthy(
    'so the warning reports a sign flip',
    formatDelta(moved.deltaBeforeMs) === '0.30s faster' && formatDelta(moved.deltaAfterMs) === '0.10s slower',
  );

  // A MOVE THAT MOVES NOTHING IS NOT A WARNING. Nudging a date within the gap it
  // already occupies changes no ranks, so the chart is identical and there is
  // nothing to report. A warning that fires on a no-op gets clicked through, and
  // then it is not a warning any more.
  const nudged = dateImpact(series, { ...mine, at: at(2025, 6, 20) }, { at: mine.at });
  check('still last', nudged.rank, 4);
  check('as it was', nudged.previousRank, 4);
  check('so it does not warn', nudged.reorders, false);
  check('and the trend is unmoved', nudged.deltaAfterMs, nudged.deltaBeforeMs);

  // THE CASE THAT SEPARATES "moved" FROM "not last". A run sitting in the MIDDLE of
  // a season, nudged by a few days without crossing anybody, still satisfies
  // rank < total — so a guard keyed on insertsIntoHistory fires every time a coach
  // corrects a mid-season date by a day. Only the comparison against where the run
  // ALREADY sat can tell the difference.
  const middle = { elapsedMs: 4250, at: at(2025, 4, 15) };
  const shuffled = dateImpact(series, { ...middle, at: at(2025, 4, 20) }, { at: middle.at });
  check('a mid-series run is not last', shuffled.rank < shuffled.total, true);
  check('and would trip an insertion test', shuffled.insertsIntoHistory, true);
  check('but its rank is unchanged', [shuffled.rank, shuffled.previousRank], [3, 3]);
  check('so it does NOT warn', shuffled.reorders, false);

  // Crossing exactly one neighbour is still a reorder, however small the step.
  const crossed = dateImpact(series, { ...mine, at: at(2025, 4, 15) }, { at: mine.at });
  check('crossing one run reorders', crossed.reorders, true);
  check('by exactly one place', crossed.rank, 3);

  // ADDING is unchanged — `replacing` omitted must behave exactly as before, or
  // this extension silently rewrote the marking screen's guard.
  const added = dateImpact(series, { elapsedMs: 4100, at: at(2025, 2, 1) });
  check('an added run has no previous rank', added.previousRank, null);
  check('and reorders because it inserts', added.reorders, added.insertsIntoHistory);
  check('total counts it as new', added.total, 4);
  check('before is the series without it', added.deltaBeforeMs, 4200 - 4400);

  // An added run dated today lands last and says nothing at all.
  const appended = dateImpact(series, { elapsedMs: 4100, at: at(2025, 7, 1) });
  check('appending is not a reorder', appended.reorders, false);
}

console.log('\n=============================');
console.log(failures === 0 ? 'RESULT: OK — backdating rules hold.' : `RESULT: ${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
