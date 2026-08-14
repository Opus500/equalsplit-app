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

/**
 * Group key for a progression series. Drill AND source — never drill alone.
 *
 * NOTE: the app does not call this. progression.ts builds the same key inline
 * because it must stay import-free, and seriesUid() there is what the UI uses.
 * This exists so verify-video can state the rule against the module that owns
 * TimeSource; the rule as the app enforces it is proved by verify-progression
 * block 15, against the real grouping path.
 */
export function seriesKey(drillId: string, source: TimeSource): string {
  return `${drillId}|${source}`;
}

// ------------------------------------------------------------------ marks

/** One marked frame: its presentation timestamp, and how long it is displayed. */
export type VideoMark = {
  /** presentation timestamp in SECONDS, as reported by the decoder */
  pts: number;
  /** this frame's own duration in seconds — from the measured grid, not 1/nominalFps */
  frameDurSec: number;
};

/**
 * Decimals shown for a video time — always two, with the ± shown beside it.
 *
 * An earlier version varied this with the clip's frame rate, so a 30fps clip
 * printed 4.2s because its ~13.6ms spread cannot support the 10ms a second
 * decimal claims. That is arithmetically right and practically wrong: a tenth is
 * too coarse to read, and rounding HIDES the uncertainty rather than stating it.
 * Two decimals next to an explicit ± says the same thing out loud, and lets the
 * coach see the digit move as they scrub.
 */
export const VIDEO_DECIMALS = 2;

export type VideoTiming = {
  elapsedMs: number;
  /** 1 sigma, from the two frames' ACTUAL durations */
  quantSdMs: number;
  /** the largest single-sided quantization error possible */
  quantWorstMs: number;
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

  return { elapsedMs, quantSdMs, quantWorstMs };
}

export function formatVideoSeconds(elapsedMs: number, decimals = VIDEO_DECIMALS): string {
  return (elapsedMs / 1000).toFixed(decimals);
}

/**
 * The time and its uncertainty, together, because neither is honest alone.
 *
 * The ± is what licenses the second decimal: at 30fps the spread is larger than
 * the digit being shown, and saying so is more use to a coach than quietly
 * dropping it.
 */
export function formatVideoTime(t: VideoTiming): string {
  return `${formatVideoSeconds(t.elapsedMs)}s ± ${Math.round(t.quantSdMs)}ms`;
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
 * The furthest into a clip a mark may be placed.
 *
 * The final frame of a clip has no measured successor, so its duration is unknown
 * and `frameIndexAt` deliberately refuses to resolve it — an error bar computed
 * from a frame length nobody measured would be invented. That refusal is correct,
 * but it means any position at or past the last frame is a dead end: no mark, no
 * stepping, no time.
 *
 * So it must never be reachable, and that has to be enforced in ONE place. It was
 * enforced in two — the import path backed off by 1.5 frames, the drag clamped to
 * the raw duration — and only one of them was right. A handle dragged to the right
 * edge stuck there permanently.
 *
 * 1.5 frames rather than 1: at exactly one frame back the last frame is still the
 * one displayed, and float error decides which side of the boundary the request
 * lands on.
 */
export function lastMarkableTime(durationSec: number, frameDurSec: number): number {
  const dur = frameDurSec > 0 ? frameDurSec : 1 / 30;
  return Math.max(0, durationSec - dur * 1.5);
}

/**
 * The +/- a clip can support before any frame has actually been measured.
 *
 * Same arithmetic as `timeFromMarks` for two frames of equal length — variance
 * d^2/12 at each end, added in quadrature — so a provisional figure and the final
 * one are the same claim computed from the same rule, not a placeholder that
 * happens to look similar. Used while a handle is moving, when the grid around it
 * has not been probed yet and there is no measured pair to work from.
 */
export function nominalSdMs(frameDurSec: number): number {
  const d = Math.max(0, frameDurSec) * 1000;
  return Math.sqrt((d * d + d * d) / 12);
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
 *
 * Clamped at zero, which the degenerate branch already did and this one did not.
 * The inconsistency was invisible because the only caller passes from = 0 — it
 * surfaced from the other side, as a test asserting "never a negative time" that
 * passed while the function returned -2.75. Negative times are meaningless to
 * extraction, so both branches now agree rather than one of them being right.
 */
export function filmstripTimes(from: number, to: number, count: number): number[] {
  const n = Math.max(1, Math.floor(count));
  if (!(to > from)) return [Math.max(0, from)];
  const step = (to - from) / n;
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) out.push(Math.max(0, from + step * (i + 0.5)));
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
 * THE GRID IS ISLANDS, NOT A SEQUENCE.
 *
 * `frames` is one sorted array, but it is built from separate probed windows with
 * unprobed clip in between — the import alone creates two, one at each end. So two
 * entries that sit next to each other in the ARRAY are not necessarily next to
 * each other in the VIDEO, and every statistic that treats them as adjacent is
 * measuring across a gap nobody looked at.
 *
 * Three functions did exactly that, and all three were wrong on every clip:
 *
 *   measuredFps    (n-1)/(last-first) spanned the whole clip, so it started near
 *                  zero and ROSE as more windows were probed, converging on the
 *                  truth only at full coverage. On a 24s clip it read 0.67fps
 *                  after import and 5.6 after scrubbing. True rate: 30.
 *   isVariableRate  one cross-island delta is enormous, so max-min always cleared
 *                  the tolerance and EVERY clip was flagged variable, including a
 *                  perfectly constant one.
 *   markAt          frames[i+1] could be the first frame of the NEXT island, so a
 *                  mark on the trailing edge of a window took its "frame duration"
 *                  from the gap: 9466ms instead of 33.3ms, and a +/-2733ms error
 *                  bar written to a saved run.
 *
 * The window a frame belongs to is what makes the difference, so it is asked for
 * explicitly rather than assumed.
 */
function windowContaining(grid: FrameGrid, t: number): FrameWindow | null {
  // Windows are merged and non-overlapping, so at most one can match.
  for (const w of grid.windows) if (t >= w.from - 1e-9 && t <= w.to + 1e-9) return w;
  return null;
}

/**
 * The duration of frame `i`, or null when it cannot be known.
 *
 * Null for the last frame overall — it has no successor — and null when the next
 * frame lies beyond this one's window, because then the two were never observed
 * as neighbours and the space between them may hold frames nobody probed.
 */
function frameDurAt(grid: FrameGrid, i: number): number | null {
  const a = grid.frames[i];
  const b = grid.frames[i + 1];
  if (a === undefined || b === undefined) return null;
  const w = windowContaining(grid, a);
  if (!w || b > w.to + 1e-9) return null;
  return b - a;
}

/**
 * Gaps between frames that really are neighbours — the only spacings that say
 * anything about the clip's frame rate. Cross-island pairs are dropped, not
 * measured.
 */
export function adjacentDeltas(grid: FrameGrid): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < grid.frames.length; i += 1) {
    const d = frameDurAt(grid, i);
    if (d !== null && d > 0) out.push(d);
  }
  return out;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
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
    // Resolvable only when this frame's own duration is KNOWN — which rules out
    // the last frame overall and, just as importantly, the last frame of any
    // probed window. Its successor in the array belongs to a different island, and
    // the distance to it is the size of an unprobed gap, not a frame length.
    if (frames[i]! <= t + 1e-9) return frameDurAt(grid, i) === null ? null : i;
  }
  return null;
}

/** The mark for the frame displayed at `t`, ready for `timeFromMarks`. */
export function markAt(grid: FrameGrid, t: number): VideoMark | null {
  const i = frameIndexAt(grid, t);
  if (i === null) return null;
  const dur = frameDurAt(grid, i);
  if (dur === null) return null;
  return { pts: grid.frames[i]!, frameDurSec: dur };
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
  if (j < 0) return null;
  const dur = frameDurAt(grid, j);
  if (dur === null) return null;
  return { pts: grid.frames[j]!, frameDurSec: dur };
}

/**
 * Measured frame rate, or null if too few neighbouring frames to say.
 *
 * The MEDIAN of real neighbour spacings, not the count divided by the span. The
 * span version silently measured the unprobed gaps between windows as though they
 * were frames, so it began near zero and climbed as more of the clip was probed —
 * see the note on windowContaining. The median also survives a dropped frame on a
 * variable-rate clip, where a mean would be dragged by it.
 */
export function measuredFps(grid: FrameGrid): number | null {
  const deltas = adjacentDeltas(grid);
  if (deltas.length < 2) return null;
  const m = median(deltas);
  return m > 0 ? 1 / m : null;
}

/**
 * Whether the probed frames are evenly spaced. Uneven means 1/fps stepping lies.
 *
 * Over neighbouring frames only. Across islands there is always one delta the size
 * of an unprobed gap, so this used to answer "yes" for every clip ever opened,
 * including a perfectly constant one — a flag that is always on tells you nothing.
 */
export function isVariableRate(grid: FrameGrid, toleranceSec = 0.0005): boolean {
  const deltas = adjacentDeltas(grid);
  if (deltas.length < 2) return false;
  return Math.max(...deltas) - Math.min(...deltas) > toleranceSec;
}

// --------------------------------------------------------- time scaling

/**
 * Whether a clip's playback time is real time.
 *
 * iOS stores slow motion and time-lapse as EDITS on a normally-recorded asset,
 * and the photo picker hands back the rendered result — a file whose duration has
 * been stretched or compressed relative to what actually happened. Nothing in the
 * file says so; it looks exactly like an ordinary clip of a different length.
 *
 * 'unknown' is a real answer, not a failure: a clip from Files has no photo-library
 * asset behind it to ask, and neither refusing every such clip nor pretending it
 * is normal would be honest.
 */
export type TimeScale = 'normal' | 'slow-motion' | 'time-lapse' | 'unknown';

export type ClipVerdict =
  /** Mark it. `warn` is shown but does not block. */
  | { accept: true; warn: string | null }
  /** Refuse, with the reason to put on screen. */
  | { accept: false; reason: string };

/**
 * Whether a clip may be TIMED.
 *
 * Refuse rather than correct, and the reason is that a correction would be
 * plausible. iPhone slow motion is RAMPED — only a segment is slowed — so there is
 * no single factor to divide by: a mark inside the slow section, one outside it
 * and one straddling the boundary each need a different number, and the ramp
 * points live in adjustment data PhotoKit does not hand out. Dividing by 8 anyway
 * would turn a visibly absurd time into a believable wrong one, and a believable
 * wrong one is the failure a coach cannot catch.
 *
 * Time-lapse is refused for the same reason pointing the other way, and is the
 * more dangerous of the two: compressed time reads as a personal best, which is
 * the direction nobody questions.
 */
export function acceptForTiming(scale: TimeScale): ClipVerdict {
  if (scale === 'slow-motion') {
    return {
      accept: false,
      reason:
        'This is a slow-motion clip. iOS hands over the slowed version, not the original, ' +
        'so its playback time is not real time and any time marked from it would be wrong ' +
        'by the slow-motion factor. The slowdown is ramped rather than constant, so it ' +
        'cannot be corrected for either.',
    };
  }
  if (scale === 'time-lapse') {
    return {
      accept: false,
      reason:
        'This is a time-lapse clip. Its playback time is compressed, so a time marked from ' +
        'it would come out far too fast — which reads as a personal best rather than as an ' +
        'error.',
    };
  }
  if (scale === 'unknown') {
    return {
      accept: true,
      warn:
        'This clip is not from your photo library, so it cannot be checked for slow motion. ' +
        'If it was recorded in slo-mo, the time will be wrong.',
    };
  }
  return { accept: true, warn: null };
}

/**
 * Whether a clip may be ATTACHED to a run as review footage.
 *
 * Deliberately more permissive: nothing computes a time from attached footage, and
 * watching a sprint in slow motion is the point of filming it that way. Refusing
 * here would remove a real use for no safety gain.
 */
export function acceptForReview(scale: TimeScale): ClipVerdict {
  if (scale === 'slow-motion' || scale === 'time-lapse') {
    return {
      accept: true,
      warn:
        `Attached as ${scale === 'slow-motion' ? 'slow-motion' : 'time-lapse'} review footage. ` +
        'It cannot be used to mark a time — its playback speed is not real time.',
    };
  }
  return { accept: true, warn: null };
}

// ------------------------------------------------------------- storage

/**
 * The timing facts for a video-timed run.
 *
 * Deliberately does NOT carry the clip id. raw_json answers "how was this timed";
 * runs.clip_id answers "is there footage". Keeping the clip here would have meant
 * that attaching review video to a GATE run had to write this JSON over the
 * gate's, flipping timeSource to 'video' and moving the run into a different
 * progression series — a review clip silently reclassifying a gate-timed run.
 */
export type VideoRunFacts = {
  startPts: number;
  endPts: number;
  /** measured, never nominal */
  fps: number;
  quantSdMs: number;
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
    };
  } catch {
    return null;
  }
}
