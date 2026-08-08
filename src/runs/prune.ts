// Choosing what counts as test data, and proving what a prune would delete.
//
// Pure — no React, no SQLite, no imports. Verified by scripts/verify-prune.mjs.
//
// THE PREDICATE: a run is prunable when it has NO athlete and was created before a
// cutoff. Drill is deliberately not part of it — a run with a drill but no athlete
// is still unattributed, and on real data that is most of the test rows.
//
// The date bound is not decoration. `athlete_id IS NULL` alone is unsafe as a
// permanent control: Unassigned is a legitimate ongoing state (standalone B1 runs
// save that way by design), so an unbounded version would quietly eat real data
// months later. The cutoff is what keeps this a one-time cleanup instead of a
// standing hazard.

export type PrunableRun = {
  id: string;
  createdAt: number;
  athleteId: string | null;
  drillId: string | null;
};

export type Period = 'week' | 'month';

export type Bucket = {
  /** sort/identity key, e.g. "2026-W31" or "2026-07" */
  key: string;
  /** human label for the row */
  label: string;
  /** inclusive start, exclusive end (ms) */
  start: number;
  end: number;
  /** every run in the period */
  total: number;
  /** how many of those have no athlete — i.e. what a cutoff here would take */
  unassigned: number;
};

export type PruneSummary = {
  matched: number;
  /** of the matched runs, how many carried a drill label */
  matchedWithDrill: number;
  /** unassigned runs NEWER than the cutoff, which are deliberately left alone */
  spared: number;
  /** runs that keep their attribution and are never eligible */
  attributed: number;
  total: number;
};

/** The predicate, in one place so the preview and the delete cannot diverge. */
export function isPrunable(run: PrunableRun, cutoff: number): boolean {
  return run.athleteId == null && run.createdAt < cutoff;
}

// Local-time period keys, matching how sessions are named (localDayString), so a
// bucket boundary lines up with the day a coach thinks a run happened rather than
// with UTC midnight.
function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function startOfWeek(ms: number): Date {
  const d = startOfLocalDay(new Date(ms));
  // Monday-based: getDay() is 0=Sun, so Sunday steps back 6 days, not 0.
  const back = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - back);
  return d;
}

function startOfMonth(ms: number): Date {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function addWeek(d: Date): Date {
  const n = new Date(d);
  n.setDate(n.getDate() + 7);
  return n;
}

function addMonth(d: Date): Date {
  const n = new Date(d);
  n.setMonth(n.getMonth() + 1);
  return n;
}

const pad = (n: number) => String(n).padStart(2, '0');

function weekKey(d: Date): string {
  // Not ISO week numbering — just a stable, sortable key derived from the week's
  // own start date. Nothing here needs to agree with anyone else's week numbers.
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const dayMonth = (d: Date) =>
  d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/**
 * Group runs into periods, newest first, so a cutoff can be picked from what the
 * data actually looks like rather than guessed.
 *
 * Empty periods are omitted: a gap between sessions is information (that IS the
 * shape of test data vs real practice), but a run of blank rows just pushes the
 * useful ones off the screen.
 */
export function bucketRuns(runs: PrunableRun[], period: Period): Bucket[] {
  const startOf = period === 'week' ? startOfWeek : (ms: number) => startOfMonth(ms);
  const next = period === 'week' ? addWeek : addMonth;
  const map = new Map<string, Bucket>();

  for (const r of runs) {
    if (!Number.isFinite(r.createdAt)) continue;
    const s = startOf(r.createdAt);
    const e = next(s);
    const key =
      period === 'week' ? weekKey(s) : `${s.getFullYear()}-${pad(s.getMonth() + 1)}`;
    let b = map.get(key);
    if (!b) {
      b = {
        key,
        label:
          period === 'week'
            ? `${dayMonth(s)} – ${dayMonth(new Date(e.getTime() - 1))}`
            : s.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
        start: s.getTime(),
        end: e.getTime(),
        total: 0,
        unassigned: 0,
      };
      map.set(key, b);
    }
    b.total += 1;
    if (r.athleteId == null) b.unassigned += 1;
  }

  return [...map.values()].sort((a, b) => b.start - a.start);
}

/**
 * What a given cutoff would do. `matchedWithDrill` is broken out because the
 * predicate ignores drill entirely, and that surprises people — seeing the number
 * is more convincing than reading the rule.
 */
export function summarize(runs: PrunableRun[], cutoff: number): PruneSummary {
  let matched = 0;
  let matchedWithDrill = 0;
  let spared = 0;
  let attributed = 0;
  for (const r of runs) {
    if (r.athleteId != null) {
      attributed += 1;
    } else if (isPrunable(r, cutoff)) {
      matched += 1;
      if (r.drillId != null) matchedWithDrill += 1;
    } else {
      spared += 1;
    }
  }
  return { matched, matchedWithDrill, spared, attributed, total: runs.length };
}

/** Cutoff for "everything up to and including this period". */
export function cutoffForBucket(b: Bucket): number {
  return b.end;
}
