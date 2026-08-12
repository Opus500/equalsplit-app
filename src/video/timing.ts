// Video timing: two marked frames to an elapsed time, and the honest error bar.
//
// Pure — no React, no SQLite, no expo-video, no imports. Verified by
// scripts/verify-video.mjs. Nothing here knows how frames are obtained, which is
// deliberate: the spike has not yet settled whether frame timestamps come from a
// thumbnail API, from player seeks, or from a native module. All three produce
// the same thing — a list of presentation timestamps — so this layer is written
// against that and is unaffected by how that fight resolves.
//
// THE RULE THAT MATTERS: a video-timed run is not a gate-timed run and the two
// must never share a series. Not because video is imprecise (it is, but noise
// averages out over a season) but because it is BIASED: a gate fires on the first
// thing through the beam — a hand, a knee — while a coach judging a frame reads
// the torso. At 8 m/s that is a systematic ~37ms, in one direction, forever.

/**
 * Run mode for a video-timed run.
 *
 * Earns a new mode because `mode` has always encoded the PRODUCER — 1 gate mode-1,
 * 2 reaction, 3 the drill engine, 4 a continuous rep set — and a video run has no
 * gate in it at all. Overloading DRILL_MODE for something the drill engine never
 * produced is the worse lie. Its row SHAPE is a single time, same as mode 3.
 */
export const VIDEO_MODE = 5;

/**
 * How a run's time was produced, end to end.
 *
 * Distinct from repeats.ts's `runStartSource`, which describes only the START of a
 * rep (a tap) whose finish is still a gate edge. A video run is video at BOTH ends.
 */
export type TimeSource = 'gate' | 'hand' | 'video';

/**
 * Read a run's time source back from storage. ONE helper, so History, the chart
 * and the series split cannot disagree about which times are comparable.
 *
 * Returns null when the row says nothing, which is every run recorded before this
 * existed. Those are gate-timed by construction, but claiming so from an absent
 * field would be inventing information — the same rule `runStartSource` follows.
 * Grouping decides separately what to do with null; see `seriesTimeSource`.
 */
export function runTimeSource(raw: string | null | undefined): TimeSource | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (v?.timeSource === 'video' || v?.engine === 'video') return 'video';
    if (v?.timeSource === 'hand') return 'hand';
    if (v?.timeSource === 'gate') return 'gate';
    // A rest rep predates this field: hand-started, gate-finished. Reported as
    // 'hand' because the hand error is the one that dominates its accuracy.
    if (v?.startSource === 'tap' || v?.engine === 'rest-rep') return 'hand';
    return null;
  } catch {
    return null;
  }
}

/**
 * The source a run is GROUPED by. Unknown folds to 'gate'.
 *
 * Not the same call as `runTimeSource` returning null: the UI must never claim an
 * old run was gate-timed, but grouping has to put it somewhere, and every run
 * predating this field genuinely is gate-timed. Folding to a fourth "unknown"
 * bucket would split every existing series in half for no gain.
 */
export function seriesTimeSource(raw: string | null | undefined): TimeSource {
  return runTimeSource(raw) ?? 'gate';
}

/** Group key for a progression series. Drill AND source — never drill alone. */
export function seriesKey(drillId: string, source: TimeSource): string {
  return `${drillId}|${source}`;
}

/** Suffix for a series' display name. Gate runs read as they always did. */
export function sourceLabel(source: TimeSource): string {
  return source === 'gate' ? '' : source === 'video' ? 'video' : 'hand start';
}

// ------------------------------------------------------------------ marks

/** One marked frame: its presentation timestamp, and how long it is displayed. */
export type VideoMark = {
  /** presentation timestamp in SECONDS, as reported by the decoder */
  pts: number;
  /** this frame's own duration in seconds — from the measured grid, not 1/nominalFps */
  frameDurSec: number;
};

export type VideoTiming = {
  elapsedMs: number;
  /** 1 sigma, from the two frames' ACTUAL durations */
  quantSdMs: number;
  /** the largest single-sided quantization error possible */
  quantWorstMs: number;
  /** decimal places this measurement can honestly carry */
  decimals: number;
};

/**
 * Elapsed time between two marked frames, with its quantization error.
 *
 * MARKING CONVENTION: the coach marks the first frame in which the athlete HAS
 * crossed. So the true crossing lies within the one frame before each mark, and
 * each mark is biased late by up to one frame duration.
 *
 * The important consequence: both ends are biased in the SAME direction, so the
 * bias very nearly cancels in the difference and the expected error is ~0 rather
 * than one frame. What is left is spread, not offset — which is why the figure
 * below is a standard deviation and not "half a frame".
 *
 * Returns null for marks that are not in order. A negative elapsed time is not a
 * measurement to be shown with a warning; it is an input error.
 */
export function timeFromMarks(a: VideoMark, b: VideoMark): VideoTiming | null {
  if (!Number.isFinite(a.pts) || !Number.isFinite(b.pts)) return null;
  if (!(b.pts > a.pts)) return null;

  const elapsedMs = (b.pts - a.pts) * 1000;
  const da = Math.max(0, a.frameDurSec) * 1000;
  const db = Math.max(0, b.frameDurSec) * 1000;
  // Each mark's error is ~uniform over one frame, so variance is d^2/12 apiece
  // and the two ends add in quadrature.
  const quantSdMs = Math.sqrt((da * da + db * db) / 12);
  const quantWorstMs = Math.max(da, db);

  return { elapsedMs, quantSdMs, quantWorstMs, decimals: videoDecimals(quantSdMs) };
}

/**
 * How many decimals a video time may show: a place is only shown when the error
 * is smaller than that place's own unit.
 *
 * At 30fps the spread is ~13.6ms, larger than the 10ms that a second decimal
 * claims to resolve — so 30fps clips print 4.2s, not 4.21s and certainly not
 * 4.213s. At 60fps and above the second decimal is earned. This is why the figure
 * comes from the clip's real frame durations and not from a constant: a 240fps
 * clip has genuinely more to say than a 30fps one and should be allowed to say it.
 */
export function videoDecimals(sdMs: number): number {
  if (!Number.isFinite(sdMs) || sdMs <= 0) return 2;
  if (sdMs < 1) return 3;
  if (sdMs < 10) return 2;
  return 1;
}

export function formatVideoSeconds(elapsedMs: number, decimals: number): string {
  return (elapsedMs / 1000).toFixed(decimals);
}

// -------------------------------------------------------------- accuracy

/**
 * Systematic error from judging a body part rather than a beam break, in ms.
 * 0.3m of body extent at 8 m/s. Deliberately NOT added to the ± figure: it is not
 * measurable from the file, and folding an estimate into a computed number would
 * make the whole thing look measured. It exists to be quoted in UI copy, and as
 * the reason gate and video runs never share a series — being a bias, it does not
 * shrink with more runs.
 */
export const BODY_PART_BIAS_MS = 37;

/**
 * Timing error from a camera that is not perpendicular to the finish plane.
 *
 * An athlete `lateralM` from where the reference was placed appears to cross
 * `lateralM * tan(deg)` early or late. Usually the largest term in a handheld
 * setup, and the one the coach can actually do something about — which is why it
 * is a function rather than a constant.
 */
export function parallaxErrorMs(deg: number, lateralM: number, speedMps: number): number {
  if (!(speedMps > 0)) return 0;
  return (Math.abs(lateralM) * Math.tan((Math.abs(deg) * Math.PI) / 180) * 1000) / speedMps;
}

// ------------------------------------------------------------ frame grid

/**
 * The measured frame grid, built up lazily.
 *
 * Clips are uncapped in length, so probing a whole file is not an option — a
 * ten-minute 240fps clip is 144,000 frames. Instead the grid grows around wherever
 * the coach is scrubbing, and `windows` records which spans have actually been
 * probed so a gap is never mistaken for an absence of frames.
 */
export type FrameWindow = { from: number; to: number };
export type FrameGrid = {
  /** presentation timestamps in seconds, ascending, deduped */
  frames: number[];
  /** merged, ascending, non-overlapping spans that have been probed */
  windows: FrameWindow[];
};

export function emptyGrid(): FrameGrid {
  return { frames: [], windows: [] };
}

/**
 * How many frame requests to have in flight at once.
 *
 * Measured, not guessed. On device, 12 sequential extractions took 221ms; at
 * width 8 they took 91ms — 2.43x, within 10% of the best observed (width 12 at
 * 2.70x) for a third of the concurrency. Most of the work serialises behind one
 * hardware decoder, so the curve flattens early and a wider fan buys memory
 * pressure rather than speed.
 *
 * Worth re-measuring when 4K/240fps clips arrive: that benchmark ran on a 548x960
 * clip, and both the per-call cost and the in-flight decode buffers scale with
 * resolution.
 */
export const FRAME_FAN_OUT = 8;

/** Split work into fan-out sized groups. */
export function chunk<T>(items: T[], size: number): T[][] {
  const n = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/**
 * The time to REQUEST in order to land on a given frame: its centre, never its
 * edge.
 *
 * Extraction is zero-tolerance, so it returns the frame whose display interval
 * contains the requested time. Asking for a time that sits exactly ON a boundary
 * is a coin flip decided by float representation — on device, 30 requests spaced
 * exactly 1/fps apart returned only 29 distinct frames, because one landed a hair
 * below a boundary and floored to the frame before. Half a frame in is
 * unambiguous.
 */
export function seekTimeFor(mark: VideoMark): number {
  return mark.pts + mark.frameDurSec / 2;
}

/**
 * Times to request in order to discover the frames around a KNOWN frame.
 *
 * One probe per frame, each half a frame past a real boundary — which is only
 * possible because `anchorPts` is an actual presentation timestamp, so the phase
 * of the frame grid is known rather than assumed.
 *
 * The earlier version probed blind at quarter-frame granularity: four calls to
 * discover each frame, because without a known phase you cannot aim. For a window
 * of 24 frames that was 96 extractions, ~730ms at the measured rate, paid on every
 * step and every drag release. Anchoring costs one extra call to find the phase
 * and then hits each frame exactly once.
 *
 * On a variable-rate clip the alignment drifts and some probes land twice in one
 * frame, leaving a hole — `gapProbes` repairs those, and only those.
 */
export function alignedProbes(
  anchorPts: number,
  frameDurSec: number,
  framesBefore: number,
  framesAfter: number,
): { window: FrameWindow; times: number[] } {
  const dur = frameDurSec > 0 ? frameDurSec : 1 / 30;
  const times: number[] = [];
  for (let k = -framesBefore; k <= framesAfter; k += 1) {
    const t = anchorPts + (k + 0.5) * dur;
    if (t > 0) times.push(t);
  }
  return {
    window: {
      from: Math.max(0, anchorPts - framesBefore * dur),
      to: anchorPts + (framesAfter + 1) * dur,
    },
    times,
  };
}

/**
 * Midpoints of gaps that are too wide to be a single frame.
 *
 * A gap above 1.5 frames means a frame was skipped — either the clip is variable
 * rate or the alignment drifted. Probing only the holes keeps the repair
 * proportional to the damage instead of re-probing the whole window.
 */
export function gapProbes(grid: FrameGrid, frameDurSec: number): number[] {
  const dur = frameDurSec > 0 ? frameDurSec : 1 / 30;
  const out: number[] = [];
  for (let i = 1; i < grid.frames.length; i += 1) {
    const a = grid.frames[i - 1]!;
    const b = grid.frames[i]!;
    if (b - a > dur * 1.5) out.push((a + b) / 2);
  }
  return out;
}

/**
 * Evenly spaced times for filmstrip tiles across [from, to].
 *
 * Tiles are a visual index, not a measurement, so these are not snapped to
 * frames — but they are nudged off the exact endpoints, because a request at or
 * past the clip's final frame is the one case where extraction has nothing to
 * return.
 */
export function filmstripTimes(from: number, to: number, count: number): number[] {
  const n = Math.max(1, Math.floor(count));
  if (!(to > from)) return [Math.max(0, from)];
  const step = (to - from) / n;
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) out.push(from + step * (i + 0.5));
  return out;
}

function mergeWindows(windows: FrameWindow[]): FrameWindow[] {
  const sorted = [...windows].sort((a, b) => a.from - b.from);
  const out: FrameWindow[] = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    // Touching counts as overlapping: two windows that meet exactly leave no gap.
    if (last && w.from <= last.to + 1e-9) last.to = Math.max(last.to, w.to);
    else out.push({ ...w });
  }
  return out;
}

/** Fold newly discovered frame timestamps into the grid. */
export function ingestFrames(grid: FrameGrid, window: FrameWindow, actualTimes: number[]): FrameGrid {
  const set = new Set(grid.frames);
  for (const t of actualTimes) if (Number.isFinite(t)) set.add(t);
  return {
    frames: [...set].sort((a, b) => a - b),
    windows: mergeWindows([...grid.windows, window]),
  };
}

export function isCovered(grid: FrameGrid, t: number): boolean {
  return grid.windows.some((w) => t >= w.from - 1e-9 && t <= w.to + 1e-9);
}

/**
 * Index of the frame displayed at time `t`, or null.
 *
 * Null when `t` is outside every probed window, and — importantly — also when `t`
 * falls on the LAST known frame, because that frame's duration is unknown until
 * its successor has been probed. Returning it anyway would let the caller compute
 * an error bar from a frame duration it does not actually know.
 */
export function frameIndexAt(grid: FrameGrid, t: number): number | null {
  if (!isCovered(grid, t)) return null;
  const { frames } = grid;
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    if (frames[i]! <= t + 1e-9) return i + 1 < frames.length ? i : null;
  }
  return null;
}

/** The mark for the frame displayed at `t`, ready for `timeFromMarks`. */
export function markAt(grid: FrameGrid, t: number): VideoMark | null {
  const i = frameIndexAt(grid, t);
  if (i === null) return null;
  return { pts: grid.frames[i]!, frameDurSec: grid.frames[i + 1]! - grid.frames[i]! };
}

/**
 * Step `delta` frames from the frame displayed at `t`.
 *
 * Refuses to leave the probed region rather than extrapolating by 1/fps — that
 * extrapolation is exactly what drifts on a variable-frame-rate clip, which iPhone
 * clips routinely are.
 */
export function stepFrames(grid: FrameGrid, t: number, delta: number): VideoMark | null {
  const i = frameIndexAt(grid, t);
  if (i === null) return null;
  const j = i + delta;
  if (j < 0 || j + 1 >= grid.frames.length) return null;
  return { pts: grid.frames[j]!, frameDurSec: grid.frames[j + 1]! - grid.frames[j]! };
}

/** Measured frame rate over the probed frames, or null if too few to say. */
export function measuredFps(grid: FrameGrid): number | null {
  if (grid.frames.length < 3) return null;
  const span = grid.frames[grid.frames.length - 1]! - grid.frames[0]!;
  if (!(span > 0)) return null;
  return (grid.frames.length - 1) / span;
}

/** Whether the probed frames are evenly spaced. Uneven means 1/fps stepping lies. */
export function isVariableRate(grid: FrameGrid, toleranceSec = 0.0005): boolean {
  if (grid.frames.length < 3) return false;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 1; i < grid.frames.length; i += 1) {
    const d = grid.frames[i]! - grid.frames[i - 1]!;
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return max - min > toleranceSec;
}

// ------------------------------------------------------------- storage

export type VideoRunFacts = {
  startPts: number;
  endPts: number;
  /** measured, never nominal */
  fps: number;
  quantSdMs: number;
  /** the stored clip this was marked from, if the coach kept it */
  clipId?: string | null;
};

/** What a video run writes into raw_json. The accuracy fact travels with the ROW,
 *  not just the UI — a video time must never be read back as gate-accurate. */
export function videoRunRawJson(f: VideoRunFacts): string {
  return JSON.stringify({
    engine: 'video',
    timeSource: 'video',
    exact: false,
    fps: f.fps,
    startPts: f.startPts,
    endPts: f.endPts,
    quantSdMs: f.quantSdMs,
    bodyPartBiasMs: BODY_PART_BIAS_MS,
    clipId: f.clipId ?? null,
  });
}

/** Read the facts back. Null when the row is not a video run. */
export function parseVideoRunJson(raw: string | null | undefined): VideoRunFacts | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (v?.engine !== 'video') return null;
    if (!Number.isFinite(v.startPts) || !Number.isFinite(v.endPts)) return null;
    return {
      startPts: v.startPts,
      endPts: v.endPts,
      fps: Number.isFinite(v.fps) ? v.fps : 0,
      quantSdMs: Number.isFinite(v.quantSdMs) ? v.quantSdMs : 0,
      clipId: typeof v.clipId === 'string' ? v.clipId : null,
    };
  } catch {
    return null;
  }
}
