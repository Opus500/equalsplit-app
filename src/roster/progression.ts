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

/** Fewest runs in one drill before a graph is drawn. Two points make a line but not
 *  a trend — the segment between them reads as a direction the data doesn't support. */
export const MIN_SERIES_RUNS = 3;

/** Floor on the y-axis span. Without it, an athlete whose times sit within 0.03s
 *  gets a chart that magnifies noise into a dramatic collapse. */
export const MIN_Y_SPAN_MS = 200;

/** Fraction of the span added above and below so points never touch the frame. */
const Y_PAD = 0.12;

export type ProgressionRun = {
  id: string;
  drillId: string | null;
  drillName: string | null;
  elapsedMs: number;
  createdAt: number;
};

export type SeriesPoint = {
  runId: string;
  elapsedMs: number;
  createdAt: number;
  /** ties count as best — a matched PB is still a PB */
  isBest: boolean;
};

export type Series = {
  drillId: string;
  drillName: string;
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
  /** runs with no drill record — deliberately NOT lumped into one series */
  unlabeledRuns: number;
  /** runs rejected as unusable (non-finite / non-positive elapsed) */
  invalidRuns: number;
  totalRuns: number;
  /** any series at all cleared MIN_SERIES_RUNS */
  hasGraphable: boolean;
};

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
  let unlabeledRuns = 0;
  let invalidRuns = 0;
  const groups = new Map<string, { name: string; runs: ProgressionRun[] }>();

  for (const r of runs) {
    if (!isUsable(r)) {
      invalidRuns++;
      continue;
    }
    if (!r.drillId) {
      unlabeledRuns++;
      continue;
    }
    let g = groups.get(r.drillId);
    if (!g) {
      g = { name: r.drillName?.trim() || 'Untitled drill', runs: [] };
      groups.set(r.drillId, g);
    }
    // A later row carrying a name wins over a blank one, so a renamed drill shows
    // its current name even if some joined rows came back null.
    if (!g.name && r.drillName) g.name = r.drillName;
    g.runs.push(r);
  }

  const series: Series[] = [];
  for (const [drillId, g] of groups) {
    // Chronological. `id` breaks ties so two runs sharing a timestamp order
    // deterministically — otherwise the chart could reshuffle between renders.
    const sorted = [...g.runs].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const times = sorted.map((r) => r.elapsedMs);
    const bestMs = Math.min(...times);
    const worstMs = Math.max(...times);
    series.push({
      drillId,
      drillName: g.name,
      points: sorted.map((r) => ({
        runId: r.id,
        elapsedMs: r.elapsedMs,
        createdAt: r.createdAt,
        isBest: r.elapsedMs === bestMs,
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

  return {
    series,
    unlabeledRuns,
    invalidRuns,
    totalRuns: runs.length,
    hasGraphable: series.some((s) => s.graphable),
  };
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
