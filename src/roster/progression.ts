// Per-athlete progression: turning a pile of runs into per-drill series.
//
// Pure — no React, no SQLite, no imports. Verified by scripts/verify-progression.mjs
// and shared with scripts/verify-migration.mjs, so the threshold the UI enforces is
// the same number the density report measures against.
//
// THE RULE THAT MATTERS: a series is grouped by drill RECORD (drill_id), never by
// label text, and two drills never share an axis. A 30m and a 40yd dash are not
// comparable, so putting them on one y-axis would draw a "trend" that is really just
// the athlete alternating between two distances.
//
// HOW the time was produced splits a series only when the two ways disagree by more
// than the thing being measured. That is one line, drawn deliberately, and it does
// not fall in the same place for every source:
//
//   gate + video  ONE series. A gate fires on the first thing through the beam; a
//                 coach judging a video frame reads the torso, and that is a
//                 systematic difference in one direction rather than noise. But it
//                 is bounded by a body, roughly a frame either way at 30fps, and a
//                 30m is a 30m — splitting it hid runs behind a second half-empty
//                 chart, and with MIN_SERIES_RUNS at 2 the split could push BOTH
//                 halves below the threshold and chart neither. Video points are
//                 MARKED instead, so the difference is visible where it matters
//                 without costing the athlete their line.
//
//   hand          ITS OWN series, unchanged. A hand start is human reaction time,
//                 ~200ms (HAND_START_ERROR_MS) — not a bias you can mark and move
//                 past, but an error larger than a season's improvement, and with
//                 the spread to match. Track and field converts between hand and
//                 electronic times rather than plotting them together, for exactly
//                 this reason. Merging it would not blur the trend; it would BE the
//                 trend.
//
// So the group key is drill AND source GROUP, where video and gate share a group.

/**
 * Fewest runs in one drill before a graph is drawn.
 *
 * Set to 2 by the coach's call. Worth knowing what that buys: a two-point chart is
 * a single straight segment, and a straight line reads as a *trend* even though two
 * samples cannot establish one — one bad rep looks like a decline. The upside is
 * that far more of a thin season is visible at all, which on real data (43 of 422
 * runs chartable) matters more.
 */
export const MIN_SERIES_RUNS = 2;

/** Floor on the y-axis span. Without it, an athlete whose times sit within 0.03s
 *  gets a chart that magnifies noise into a dramatic collapse. */
export const MIN_Y_SPAN_MS = 200;

/** Fraction of the span added above and below so points never touch the frame. */
const Y_PAD = 0.12;

/**
 * How the time was produced. Declared here rather than imported: this module is
 * deliberately import-free so the verify scripts can load it standalone, the same
 * reason migrations.ts restates ENGINE_DRILL_LABELS. The canonical definition —
 * and the raw_json reader that produces it — is src/video/timing.ts.
 */
export type TimeSource = 'gate' | 'hand' | 'video';

/**
 * Which SERIES a time source belongs to — the grouping key, not the source itself.
 *
 * Two values, not three, and that is the whole of the merge: 'timed' holds gate and
 * video together, 'hand' stays alone. Kept as a named type rather than an inline
 * ternary so the rule has one home and a test can point at it.
 */
export type SeriesGroup = 'timed' | 'hand';

/** See SeriesGroup. Unknown folds to gate before it gets here. */
export function sourceGroup(source: TimeSource): SeriesGroup {
  return source === 'hand' ? 'hand' : 'timed';
}

export type ProgressionRun = {
  id: string;
  drillId: string | null;
  drillName: string | null;
  elapsedMs: number;
  createdAt: number;
  /** Absent means gate — every run predating the field is gate-timed. Callers
   *  should pass seriesTimeSource(raw_json), which already folds unknown to gate. */
  timeSource?: TimeSource | null;
  /** Optional extra shown in the chart readout when this point is selected —
   *  a rep set's individual splits, say. The chart plots ONE value per run, so
   *  this is how a multi-interval run keeps its detail reachable without putting
   *  several points on an axis that means "one effort per point". */
  note?: string | null;
  /** The coach's own note on the run. Distinct from `note` above, which is a
   *  DERIVED description of the run's shape — this one is typed by a person and
   *  is the only field here that round-trips to storage. */
  userNote?: string | null;
  /** Stored video for this run, if any. Independent of `timeSource`: a gate run
   *  can carry review footage without being a video-TIMED run. */
  clipId?: string | null;
  /**
   * Whether `createdAt` is a date the coach set rather than when the row was
   * written.
   *
   * Carried through to the point so the chart can MARK it. The x-axis is run
   * order, so a backdated run does not merely sit further left — it changes which
   * run is first, and therefore the series' whole trend. A chart with an odd shape
   * needs its explanation on the chart, not one screen away.
   */
  backdated?: boolean;
};

export type SeriesPoint = {
  runId: string;
  elapsedMs: number;
  createdAt: number;
  /**
   * How THIS point was timed.
   *
   * On the point rather than only on the series, because a series can now hold more
   * than one source. This is what lets the chart mark a video point and the readout
   * say how the number was got — the merge is only defensible if the distinction
   * survives it somewhere visible.
   */
  timeSource: TimeSource;
  /** ties count as best — a matched PB is still a PB */
  isBest: boolean;
  /** see ProgressionRun.note */
  note: string | null;
  /** see ProgressionRun.userNote */
  userNote: string | null;
  /** see ProgressionRun.clipId */
  clipId: string | null;
  /** see ProgressionRun.backdated */
  backdated: boolean;
};

export type Series = {
  drillId: string;
  drillName: string;
  /** which bucket this series is — see SeriesGroup. NOT "what produced these
   *  times": a 'timed' series can hold gate and video points together. */
  group: SeriesGroup;
  /** the distinct sources actually present, in a stable order. One entry is the
   *  ordinary case; two means gate and video are sharing this line. */
  sources: TimeSource[];
  /** shorthand for sources.length > 1. The caveat that a trend is drawn across two
   *  ways of measuring belongs on the chart, not in a help page. */
  mixed: boolean;
  /** chronological, oldest first */
  points: SeriesPoint[];
  bestMs: number;
  worstMs: number;
  firstMs: number;
  latestMs: number;
  /** latest - first. NEGATIVE = faster = improving. */
  deltaMs: number;
  /** least-squares slope in ms per run; negative = improving */
  slopeMsPerRun: number;
  /** enough runs to draw. Below this the stats are still valid and shown as text. */
  graphable: boolean;
};

export type Progression = {
  series: Series[];
  /**
   * Runs with no drill record, as a flat list — NEVER a Series.
   *
   * They are kept out of `series` on purpose and that has not changed: a 10m and
   * a 40yd both landing in one bucket would share a y-axis and draw a line that
   * means nothing. But the no-mixing rule protects the AXIS, and a list has no
   * axis. These runs are real and need playing, annotating and deleting like any
   * other, so they are handed over separately for listing and are structurally
   * incapable of being charted.
   *
   * isBest is false throughout: a "personal best" across mixed distances is not a
   * fact, and marking one would be the exact claim the grouping rule forbids.
   */
  unlabeled: SeriesPoint[];
  /** how many of them, kept as a plain count for footnotes */
  unlabeledRuns: number;
  /** runs rejected as unusable (non-finite / non-positive elapsed) */
  invalidRuns: number;
  totalRuns: number;
  /** any series at all cleared MIN_SERIES_RUNS */
  hasGraphable: boolean;
};

/** Stable reporting order for Series.sources. */
const ORDERED_SOURCES: TimeSource[] = ['gate', 'video', 'hand'];

function isUsable(r: ProgressionRun): boolean {
  return Number.isFinite(r.elapsedMs) && r.elapsedMs > 0;
}

/** Least-squares slope of ms against run ORDER (not wall-clock — see buildProgression). */
function slope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const meanX = (n - 1) / 2;
  let meanY = 0;
  for (const v of values) meanY += v;
  meanY /= n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - meanX;
    num += dx * (values[i]! - meanY);
    den += dx * dx;
  }
  return den === 0 ? 0 : num / den;
}

/**
 * Group an athlete's runs into per-drill series.
 *
 * Runs with no drill record are counted but never charted. Bucketing them together
 * would be the exact mixing that's forbidden — "untagged" is not a drill type, and a
 * 10m and a 40yd both landing there would draw a meaningless line.
 */
export function buildProgression(runs: ProgressionRun[]): Progression {
  const unlabeled: SeriesPoint[] = [];
  let invalidRuns = 0;
  const groups = new Map<
    string,
    { drillId: string; group: SeriesGroup; name: string; runs: ProgressionRun[] }
  >();

  for (const r of runs) {
    if (!isUsable(r)) {
      invalidRuns++;
      continue;
    }
    if (!r.drillId) {
      unlabeled.push({
        runId: r.id,
        elapsedMs: r.elapsedMs,
        createdAt: r.createdAt,
        // Never a PB — see Progression.unlabeled.
        isBest: false,
        note: r.note ?? null,
        userNote: r.userNote ?? null,
        clipId: r.clipId ?? null,
        backdated: r.backdated ?? false,
        timeSource: r.timeSource ?? 'gate',
      });
      continue;
    }
    // Drill AND source GROUP — so gate and video land together and hand does not.
    // Absent folds to gate: every run recorded before the field existed is
    // gate-timed, and an "unknown" bucket would split an existing season in half
    // for no gain.
    const source: TimeSource = r.timeSource ?? 'gate';
    const group = sourceGroup(source);
    const key = `${r.drillId}|${group}`;
    let g = groups.get(key);
    if (!g) {
      g = { drillId: r.drillId, group, name: r.drillName?.trim() || 'Untitled drill', runs: [] };
      groups.set(key, g);
    }
    // A later row carrying a name wins over a blank one, so a renamed drill shows
    // its current name even if some joined rows came back null.
    if (!g.name && r.drillName) g.name = r.drillName;
    g.runs.push(r);
  }

  const series: Series[] = [];
  for (const g of groups.values()) {
    // Chronological. `id` breaks ties so two runs sharing a timestamp order
    // deterministically — otherwise the chart could reshuffle between renders.
    const sorted = [...g.runs].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const times = sorted.map((r) => r.elapsedMs);
    const bestMs = Math.min(...times);
    const worstMs = Math.max(...times);
    // Declared order, not encounter order: a series must not report its sources
    // differently depending on which run happened to come first.
    const present = ORDERED_SOURCES.filter((src) => sorted.some((r) => (r.timeSource ?? 'gate') === src));
    series.push({
      drillId: g.drillId,
      drillName: g.name,
      group: g.group,
      sources: present,
      mixed: present.length > 1,
      points: sorted.map((r) => ({
        runId: r.id,
        elapsedMs: r.elapsedMs,
        createdAt: r.createdAt,
        isBest: r.elapsedMs === bestMs,
        note: r.note ?? null,
        userNote: r.userNote ?? null,
        clipId: r.clipId ?? null,
        backdated: r.backdated ?? false,
        timeSource: r.timeSource ?? 'gate',
      })),
      bestMs,
      worstMs,
      firstMs: times[0]!,
      latestMs: times[times.length - 1]!,
      deltaMs: times[times.length - 1]! - times[0]!,
      slopeMsPerRun: slope(times),
      graphable: times.length >= MIN_SERIES_RUNS,
    });
  }

  // Graphable first, then most-recently-used: whatever they're working on today is
  // what they open this screen to see.
  series.sort((a, b) => {
    if (a.graphable !== b.graphable) return a.graphable ? -1 : 1;
    const aLast = a.points[a.points.length - 1]!.createdAt;
    const bLast = b.points[b.points.length - 1]!.createdAt;
    return bLast - aLast;
  });

  // Newest first, matching the run list everywhere else: a coach scanning a list
  // is looking for what just happened.
  unlabeled.sort((a, b) => b.createdAt - a.createdAt || (a.runId < b.runId ? 1 : -1));

  return {
    series,
    unlabeled,
    unlabeledRuns: unlabeled.length,
    invalidRuns,
    totalRuns: runs.length,
    hasGraphable: series.some((s) => s.graphable),
  };
}

/**
 * Display title for a series.
 *
 * The drill's own name, with a suffix only where two series of the SAME drill can
 * sit side by side in the pager — which since the merge is the hand-started case
 * alone. A video series is titled "30m" like any other, because it is the athlete's
 * 30m; which runs came off a phone is said per POINT, where the difference actually
 * applies, rather than in a heading that would also be describing the gate runs
 * sharing the line.
 */
export function seriesTitle(s: Series): string {
  return s.group === 'hand' ? `${s.drillName} · hand start` : s.drillName;
}

/** How one point was timed, for the chart readout. Gate is unlabelled — it is the
 *  baseline every other source is being compared to. */
export function pointSourceLabel(source: TimeSource): string | null {
  if (source === 'video') return 'video-timed';
  if (source === 'hand') return 'hand-started';
  return null;
}

/**
 * Stable unique identity for a series — for React keys and for "did the series
 * change?" comparisons.
 *
 * drillId ALONE is not unique: one drill can produce a timed series and a
 * hand-started one at the same time. Keying a list on drillId would give React
 * duplicate keys and let it reuse the wrong chart's state.
 *
 * The GROUP, never the sources. A series' uid must not change when a video run
 * joins a gate series — that would remount the chart and drop the coach's selection
 * for a reason they did nothing to cause.
 */
export function seriesUid(s: Series): string {
  return `${s.drillId}|${s.group}`;
}

/**
 * Y-axis bounds for one series.
 *
 * NEVER zero-based: sprint times cluster in a narrow band well away from zero, so a
 * zero-based axis flattens every real difference into one horizontal line. The cost
 * is that small differences look big, which MIN_Y_SPAN_MS is there to bound.
 */
export function yBounds(series: Series): { min: number; max: number } {
  const { bestMs, worstMs } = series;
  let min = bestMs;
  let max = worstMs;
  const span = max - min;
  if (span < MIN_Y_SPAN_MS) {
    const grow = (MIN_Y_SPAN_MS - span) / 2;
    min -= grow;
    max += grow;
  }
  const pad = (max - min) * Y_PAD;
  return { min: Math.max(0, min - pad), max: max + pad };
}

/** Readable step sizes: a power of ten times one of these. */
const TICK_MANTISSAS = [0.5, 1, 2, 2.5, 5, 10];

function ticksForStep(min: number, max: number, step: number): number[] {
  const out: number[] = [];
  const first = Math.ceil(min / step) * step;
  for (let t = first; t <= max + step * 1e-9; t += step) {
    // Re-round: repeated addition of a fractional step drifts.
    out.push(Math.round(t / step) * step);
  }
  return out;
}

/**
 * Tick values inside [min, max], rounded to readable numbers.
 *
 * Picks the step whose resulting tick COUNT lands closest to `count`, rather than
 * the first step at least as large as the rough interval. The naive rule silently
 * degrades: a 226ms span asking for 4 ticks rounds its 75ms interval up to 100 and
 * draws two gridlines, which reads as a broken axis rather than a sparse one.
 * Ties go to the larger step — fewer labels, less clutter.
 */
export function yTicks(min: number, max: number, count = 4): number[] {
  if (!(max > min)) return [min];
  const target = Math.max(2, count);
  const rough = (max - min) / Math.max(1, target - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));

  let best: number[] | null = null;
  let bestScore = Infinity;
  for (const m of TICK_MANTISSAS) {
    const ticks = ticksForStep(min, max, m * mag);
    if (ticks.length < 2) continue;
    const score = Math.abs(ticks.length - target);
    if (score < bestScore) {
      bestScore = score;
      best = ticks;
    }
  }
  return best ?? [min, max];
}

/**
 * Vertical position 0..1 for a value, where **0 is the TOP** of the plot.
 *
 * The y-axis is TIME, increasing upward — so a faster (smaller) time sits LOWER and
 * improvement reads as a falling line. That matches how the times are talked about
 * ("bringing his 30 down"); flipping it so "better is up" would put 4.0s above 4.4s
 * on an axis labelled in seconds, which is a chart that lies about its own labels.
 */
export function yFraction(value: number, min: number, max: number): number {
  if (!(max > min)) return 0.5;
  const f = (value - min) / (max - min);
  return 1 - Math.min(1, Math.max(0, f));
}

/** Horizontal position 0..1 by run ORDER, not wall-clock. A three-month layoff would
 *  otherwise squash a whole season into the left edge; coaches read these by session
 *  sequence, and the dates are on the axis labels for when the gap matters. */
export function xFraction(index: number, total: number): number {
  if (total <= 1) return 0.5;
  return index / (total - 1);
}

export function formatMs(ms: number): string {
  return (ms / 1000).toFixed(2);
}

/** "0.28s faster" / "0.11s slower" / "no change" — sign spelled out, never a bare −. */
export function formatDelta(deltaMs: number): string {
  const abs = Math.abs(deltaMs);
  if (abs < 5) return 'no change';
  return `${(abs / 1000).toFixed(2)}s ${deltaMs < 0 ? 'faster' : 'slower'}`;
}
