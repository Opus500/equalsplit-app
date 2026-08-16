// When a run HAPPENED, as distinct from when it was recorded.
//
// Pure — no React, no SQLite, no imports. Verified by scripts/verify-rundate.mjs.
//
// THE TWO DATES ARE DIFFERENT QUESTIONS and they live in different columns, the
// same argument as raw_json ("how was this timed") against clip_id ("is there
// footage"). `created_at` is when the row was written and is never edited;
// `performed_at` is when the athlete actually ran and is null for every run timed
// live, because for those the two are the same thing by construction.
//
// Overwriting created_at instead would have been one fewer column and would have
// destroyed the ability to tell a backdated run from one recorded at the time —
// permanently, with no way back.
//
// WHY THIS NEEDS A GUARD AT ALL. The progression chart positions points by run
// ORDER, not by wall-clock (see xFraction). So a date does not merely slide a
// point sideways: it changes the run's RANK, and rank decides which run is
// `firstMs` and which is `latestMs`. A mistyped year makes a run the athlete's
// earliest and rewrites the trend for the whole series. That is why the warning
// below reports the CONSEQUENCE rather than echoing the value back — a wrong day
// produces no alarming sentence and needs none, while a wrong year produces one
// that is impossible to read past.

/** Milliseconds in a day. Local-day comparisons use real Date parts, not this —
 *  it is here for the readable bounds below. */
const DAY_MS = 86_400_000;

/**
 * The date a run should be filed under: what the coach said, or failing that when
 * the row was written.
 *
 * ONE helper, so the chart, the run list and History cannot disagree about which
 * date a run has. Every screen that shows or sorts by a run's date goes through
 * this.
 */
export function effectiveRunDate(
  performedAt: number | null | undefined,
  createdAt: number,
): number {
  return Number.isFinite(performedAt) && performedAt ? (performedAt as number) : createdAt;
}

/**
 * Whether a run is marked as having happened on a different DAY than it was
 * recorded.
 *
 * The day, not the millisecond: a clip filmed this morning and marked this
 * afternoon is not "backdated" in any sense a coach means, and flagging it would
 * make the marker meaningless through sheer frequency. Local calendar day,
 * matching how sessions are named — an evening session belongs to that evening,
 * not to tomorrow in UTC.
 */
export function isBackdated(
  performedAt: number | null | undefined,
  createdAt: number,
): boolean {
  if (!Number.isFinite(performedAt) || !performedAt) return false;
  return !sameLocalDay(performedAt as number, createdAt);
}

export function sameLocalDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  );
}

// ------------------------------------------------------------------ input

/**
 * How far back a date may be set.
 *
 * Five years. Not a technical limit — it is the bound that makes a mistyped year
 * catchable. "2015" for "2025" is inside no sensible coaching horizon, and a
 * typed year is the single most likely error because it is the field furthest
 * from the one being thought about.
 */
export const MAX_BACKDATE_MS = 5 * 365 * DAY_MS;

export type ParsedDate =
  | { ok: true; at: number }
  | { ok: false; reason: string };

/**
 * Read a typed YYYY-MM-DD into an epoch timestamp.
 *
 * Strict on purpose. It rejects rather than coerces, because `new Date(text)` is
 * famously accommodating — it will take "2026-02-31" and hand back 3 March, which
 * is the kind of silent correction that puts a run on a day nobody chose.
 *
 * Resolves to local NOON, not midnight. A date is a day, and anchoring it in the
 * middle means no timezone shift, DST change or clock skew can push it onto the
 * neighbouring one.
 */
export function parseDateInput(text: string, now = Date.now()): ParsedDate {
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})\s*$/.exec(text ?? '');
  if (!m) return { ok: false, reason: 'Use the form 2026-08-13.' };

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return { ok: false, reason: `There is no month ${month}.` };
  if (day < 1 || day > 31) return { ok: false, reason: `There is no day ${day}.` };

  const at = new Date(year, month - 1, day, 12, 0, 0, 0).getTime();
  const back = new Date(at);
  // The round-trip catches every impossible date without a table of month
  // lengths: JS rolls 31 February forward to March, so the parts come back
  // different from the ones asked for.
  if (back.getFullYear() !== year || back.getMonth() !== month - 1 || back.getDate() !== day) {
    return { ok: false, reason: `${text.trim()} is not a real date.` };
  }

  // A run cannot have happened tomorrow. Compared on the local day so "today"
  // is always accepted however the clocks are set.
  if (at > now && !sameLocalDay(at, now)) {
    return { ok: false, reason: 'A run cannot have happened in the future.' };
  }
  if (now - at > MAX_BACKDATE_MS) {
    return { ok: false, reason: 'That is more than five years ago — check the year.' };
  }
  return { ok: true, at };
}

/**
 * The same calendar day, anchored at local NOON.
 *
 * The wheel picker hands back midnight in the device's zone. Storing that leaves a
 * date one hour from rolling backwards over a DST boundary or a timezone change —
 * the run would silently move to the previous day. Noon is the furthest point from
 * both edges, which is why parseDateInput builds its result there too.
 */
export function localNoon(at: number): number {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0).getTime();
}

/** YYYY-MM-DD, for seeding the input with a date the coach can edit in place. */
export function toDateInput(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ----------------------------------------------------------- consequence

export type DateImpact = {
  /** 1-based position this run would take among the series' runs, by date */
  rank: number;
  total: number;
  /**
   * True when the run lands anywhere but last — that is, it is INSERTED into
   * existing history rather than appended to it.
   *
   * This is the trigger for warning, and it is the right one: a run dated today
   * always lands last and needs no warning at all, while any date that reorders
   * the series is exactly the case where a typo does damage.
   */
  insertsIntoHistory: boolean;
  becomesEarliest: boolean;
  /**
   * Where the run sits NOW, when it is already in the series (see `replacing`).
   * Null for a run being added, which is nowhere yet.
   */
  previousRank: number | null;
  /**
   * Does this date change where the run sits RELATIVE TO THE OTHERS?
   *
   * The trigger for warning, and the honest one in both directions. Adding a run
   * anywhere but last reorders the series. MOVING a run only reorders it if the
   * new date crosses another run — retyping the same day, or nudging a date within
   * the gap it already occupies, changes nothing on the chart and should not raise
   * a warning that then gets clicked through out of habit.
   */
  reorders: boolean;
  /** first-to-latest delta as the series stands TODAY — without this run when it is
   *  being added, with it at its current date when it is being moved. Null with
   *  fewer than two runs. */
  deltaBeforeMs: number | null;
  /** the same delta WITH this run at the candidate date */
  deltaAfterMs: number | null;
};

/**
 * What placing a run at `at` would do to a series.
 *
 * Takes the series' existing runs as plain {elapsedMs, at} pairs so this stays
 * import-free and can be tested without building a Progression.
 *
 * The delta reported is latest-minus-first, the same figure the chart's summary
 * shows, because that is the number a coach would notice changing. NEGATIVE is
 * faster, matching formatDelta.
 */
export function dateImpact(
  existing: { elapsedMs: number; at: number }[],
  candidate: { elapsedMs: number; at: number },
  /**
   * Where the candidate sits TODAY, when it is already a saved run being re-dated
   * rather than a new one being added.
   *
   * Without this, "before" means the series with the run removed entirely, which is
   * a chart the coach has never seen — so the warning would report a change against
   * a baseline that does not exist, and would count the run twice in the total.
   */
  replacing?: { at: number },
): DateImpact {
  const others = [...existing].sort((a, b) => a.at - b.at);
  const current = replacing ? { elapsedMs: candidate.elapsedMs, at: replacing.at } : null;
  const before = current ? [...others, current].sort((a, b) => a.at - b.at) : others;
  const after = [...others, candidate].sort((a, b) => a.at - b.at);

  // Ties go to the NEW run being later, matching "it was added afterwards".
  let rank = after.findIndex((r) => r === candidate) + 1;
  if (rank < 1) rank = after.length;

  let previousRank: number | null = null;
  if (current) {
    previousRank = before.findIndex((r) => r === current) + 1;
    if (previousRank < 1) previousRank = before.length;
  }

  const deltaOf = (rows: { elapsedMs: number }[]) =>
    rows.length >= 2 ? rows[rows.length - 1]!.elapsedMs - rows[0]!.elapsedMs : null;

  return {
    rank,
    total: after.length,
    insertsIntoHistory: rank < after.length,
    becomesEarliest: rank === 1 && others.length > 0,
    previousRank,
    reorders: previousRank === null ? rank < after.length : rank !== previousRank,
    deltaBeforeMs: deltaOf(before),
    deltaAfterMs: deltaOf(after),
  };
}
