// Video timing: two marked frames to an elapsed time, and the honest error bar.
//
// Pure — no React, no SQLite, no expo-video, no imports. Verified by
// scripts/verify-video.mjs. Nothing here knows how frames are obtained, which is
// deliberate: the spike has not yet settled whether frame timestamps come from a
// thumbnail API, from player seeks, or from a native module. All three produce
// the same thing — a list of presentation timestamps — so this layer is written
// against that and is unaffected by how that fight resolves.
//
// THE RULE THAT MATTERS: a video-timed run is not a gate-timed run, and the
// difference is a BIAS rather than noise. A gate fires on the first thing through
// the beam — a hand, a knee — while a coach judging a frame reads the torso. At
// 8 m/s that is a systematic ~37ms, in one direction, forever, so it does not
// average out over a season the way imprecision does.
//
// They now SHARE a series anyway, and the video points are marked on it. That is a
// judgement about which cost is larger, not a retraction of the bias: splitting a
// drill in two could leave both halves under MIN_SERIES_RUNS and chart neither,
// which is a certain loss against a bounded one. The estimate below is what the UI
// quotes; progression.ts's sourceGroup is where the line between merging and
// splitting is actually drawn, and it still splits hand starts.

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
 * and the series grouping cannot disagree about how a time was produced.
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
 * predating this field genuinely is gate-timed. Folding to an "unknown" bucket
 * would split every existing series in half for no gain.
 *
 * What the group DOES with the answer lives in progression.ts's sourceGroup —
 * gate and video share a series, hand does not. There is no second copy of that
 * rule here; there used to be, and it was free to drift.
 */
export function seriesTimeSource(raw: string | null | undefined): TimeSource {
  return runTimeSource(raw) ?? 'gate';
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
  /**
   * The +/- to show, in ms: one whole frame at the coarser end, rounded up.
   *
   * NOT a standard deviation any more, and not named like one. See timeFromMarks.
   */
  errorMs: number;
};

/**
 * Round UP to a tenth of a millisecond.
 *
 * Up, not to nearest, because the whole point of this figure is that it must never
 * understate. A number that rounds down is a smaller claim than the evidence
 * supports, which is the failure this change exists to remove.
 */
export function ceilTenth(ms: number): number {
  return Math.ceil(ms * 10) / 10;
}

/**
 * Elapsed time between two marked frames, with the error it carries.
 *
 * MARKING CONVENTION: the coach marks the first frame in which the athlete HAS
 * crossed. So the true crossing lies within the one frame before each mark, and
 * each mark is biased late by up to one frame duration. Both ends are biased in the
 * SAME direction, so the bias very nearly cancels in the difference.
 *
 * THE FIGURE IS A WHOLE FRAME PERIOD, AND IT USED TO BE A STANDARD DEVIATION.
 *
 * The old number was sqrt((da^2 + db^2)/12) — the statistical spread from landing
 * anywhere within a frame at each end. That is correct in isolation and it was the
 * wrong number to show, for a reason arithmetic cannot see: it sits on screen beside
 * two LARGER errors that are not in it at all. Camera parallax is not modelled, and
 * the body-part bias is an estimate at roughly 37ms. Printing +/-1.7ms next to those
 * claims a precision the method does not have, and a coach reading it would be right
 * to believe the video was tighter than it is.
 *
 * So it is now the worst case: one full frame, at whichever end has the longer one,
 * rounded UP. 240fps reads 4.2ms rather than 1.7. It is a number that can be
 * defended without a footnote, which the tighter one could not be.
 *
 * SAVED ROWS ARE NOT RECOMPUTED. Old rows keep the figure they were written with,
 * under the old `quantSdMs` key; new rows carry `errorMs`. See parseVideoRunJson.
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
  // The LONGER of the two frames, whole. A mixed-rate pair is only as good as its
  // coarser end, and averaging them would hide that.
  const errorMs = ceilTenth(Math.max(da, db));

  return { elapsedMs, errorMs };
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
  // One decimal, because the figures now differ by a tenth where it matters —
  // 4.2 against 8.3 is the whole 240-vs-120 argument, and Math.round flattened
  // both to single digits.
  return `${formatVideoSeconds(t.elapsedMs)}s ± ${t.errorMs.toFixed(1)}ms`;
}

// -------------------------------------------------------------- accuracy

/**
 * Systematic error from judging a body part rather than a beam break, in ms.
 * 0.3m of body extent at 8 m/s. Deliberately NOT added to the ± figure: it is not
 * measurable from the file, and folding an estimate into a computed number would
 * make the whole thing look measured. It exists to be quoted in UI copy.
 *
 * AN ESTIMATE, not a measurement — derived from body geometry and a speed, never
 * observed. It is quotable and it is the reason video points are MARKED on a chart
 * they share with gate points; it is not strong enough to have justified keeping
 * them on separate charts. Marking a rep on video that was simultaneously
 * gate-timed measures it directly, and a handful of those would replace this
 * number with a real one.
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
 * How far short of the last known frame a handle must stop.
 *
 * A MILLISECOND, for the same reason alignedProbes aims its tail rescue a millisecond
 * inside the clip end rather than half a frame back: the final frame of a clip is
 * usually a PARTIAL one, so any epsilon expressed as a fraction of a frame is wrong
 * exactly when the remainder is short. Any frame long enough to mark is longer than a
 * millisecond, and this only has to clear frameIndexAt's 1e-9 tolerance.
 */
const MARK_EDGE_EPS_SEC = 0.001;

/**
 * The furthest a handle may go, MEASURED rather than assumed.
 *
 * lastMarkableTime backs off a fixed 1.5 frames from the clip's duration, which is a
 * guess made before any frame is known — and it is the wrong KIND of rule, not merely
 * the wrong constant. What it should back off to is the last frame that actually has a
 * measured successor, and after the load probe the grid already knows: alignedProbes
 * fetches the clip's final frame deliberately with its tail rescue, so every position
 * below that frame resolves with a real duration. The formula was refusing marks that
 * work.
 *
 * Measured on a 0.17s 120fps recording: the formula stopped the handle at 0.1575 while
 * positions resolved up to 0.1666 — 9.1ms, 5.4% of the whole clip, showing as a band
 * at the end that the handle would not enter. At 30fps the same clip loses 46.6ms, a
 * quarter of it. On a 3s clip it is 0.1%, which is why this survived so long.
 *
 * THE LATER OF THE TWO, which is what makes it safe. A grid whose highest frame is
 * mid-clip — a sparse grid, or a load whose tail probe failed — would otherwise clamp
 * the handle to the middle of the clip and put the finish mark out of reach. Taking
 * the max means the formula is a floor that can only ever be improved on.
 *
 * WHAT STAYS UNREACHABLE is the final frame's own display interval, and no amount of
 * probing can change that: nothing follows the last frame, so its duration cannot be
 * measured, and markAt refuses it rather than inventing an error bar. That is about
 * 2% of a short clip's strip.
 */
export function markableEnd(grid: FrameGrid, durationSec: number, frameDurSec: number): number {
  const seed = lastMarkableTime(durationSec, frameDurSec);
  const last = grid.frames[grid.frames.length - 1];
  if (last === undefined) return seed;
  return Math.max(seed, last - MARK_EDGE_EPS_SEC);
}

/**
 * The +/- a clip can support before any frame has actually been measured.
 *
 * Same rule as `timeFromMarks` for two frames of equal length, so a provisional
 * figure and the final one are the same claim computed the same way rather than a
 * placeholder that happens to look similar. Used while a handle is moving, when the
 * grid around it has not been probed and there is no measured pair to work from.
 */
export function nominalErrorMs(frameDurSec: number): number {
  return ceilTenth(Math.max(0, frameDurSec) * 1000);
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
 *
 * BOUNDED AT BOTH ENDS. Probes at or below zero were always dropped; probes past
 * the end of the clip were not, and near a finish mark that is up to eight
 * extractions returning the same clamped last frame — roughly 200ms of pure waste,
 * at precisely the moment the coach is nudging the mark that decides the time.
 *
 * ONE probe is kept when the tail is cut, aimed a millisecond inside the end. That
 * is not tidiness, it is the difference between this and the regression it would
 * otherwise be: the last frame IN the clip is what gives the second-to-last frame a
 * successor, and without a successor markAt refuses the second-to-last frame too.
 * Dropping the tail wholesale would shrink the markable region by an extra frame
 * every time — the same shape as the coverage-versus-usability bug in
 * probeGridAround, arrived at from the other direction.
 *
 * A MILLISECOND, not half a frame. A clip's final frame is usually a PARTIAL one —
 * duration is rarely an exact multiple of the frame period — and aiming half a
 * frame back lands in the frame before it whenever that remainder is short, which
 * is precisely the case the rescue exists for. Any frame long enough to mark is
 * longer than a millisecond.
 */
export function alignedProbes(
  anchorPts: number,
  frameDurSec: number,
  framesBefore: number,
  framesAfter: number,
  /** Clip length. Omit (or pass 0) to leave the tail unbounded, as before. */
  durationSec?: number,
): { window: FrameWindow; times: number[] } {
  const dur = frameDurSec > 0 ? frameDurSec : 1 / 30;
  const end = durationSec && durationSec > 0 ? durationSec : Infinity;
  const times: number[] = [];
  let cut = false;
  for (let k = -framesBefore; k <= framesAfter; k += 1) {
    const t = anchorPts + (k + 0.5) * dur;
    if (t <= 0) continue;
    if (t >= end) {
      cut = true;
      continue;
    }
    times.push(t);
  }
  if (cut) {
    const tail = end - 0.001;
    const last = times[times.length - 1];
    if (tail > 0 && (last === undefined || tail > last + 1e-9)) times.push(tail);
  }
  return {
    window: {
      // NOT clamped to `durationSec`, deliberately. A window records where the
      // decoder has been ASKED, and "past the end, nothing there" is a real answer
      // worth remembering. Clamping it would make isCovered false forever beyond
      // the last frame, so every step near the finish would re-probe a region
      // already known to be empty — a stall in place of a saving.
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
    // WITHIN ONE WINDOW ONLY — the island rule again, and this was the instance
    // that cost real time rather than only telling a lie.
    //
    // Without it, every boundary between probed windows reads as a hole: after a
    // scrubbing session with 40 windows, a single probe returned 39 "repairs" on
    // a perfectly constant clip, each one an extraction at ~25ms. Worse, it
    // compounded — a repair probe drops ONE frame into the middle of unprobed
    // clip, which splits that gap in two and yields two holes next time. The
    // repair budget grew with every probe.
    //
    // A gap between two windows is not damage. It is clip nobody has looked at,
    // and probing its midpoint discovers nothing useful.
    const w = windowContaining(grid, a);
    if (!w || b > w.to + 1e-9) continue;
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

/**
 * The window a probe may honestly claim, given what came back.
 *
 * THE ROOT OF THE SNAPPING LOCK, arrived at from the third direction. ingestFrames
 * recorded the range that was ASKED about, not the range actually covered by
 * frames. Every failed extraction therefore left a HOLE under a claimed span, and a
 * claimed span with no frames in it is the exact condition that made a mark
 * covered-but-unresolvable — permanently, because probeGridAround then declined to
 * look again.
 *
 * spanCovered fixed the version of this caused by two windows and a gap between
 * them. It could not fix this one, because here there is only ONE window and the
 * hole is inside it. And probeToResolve only reaches a mark within about sixteen
 * frames of the last known one, which is why the fix before this was intermittent:
 * it depended on how far into the hole the mark had landed.
 *
 * So a window now claims only as far as its frames reach. A region with no frames
 * reads as uncovered, which is what it is, and the ordinary probe fills it.
 *
 * THE ONE EXCEPTION IS THE TAIL, and it is deliberate. Probes past the clip's end
 * return nothing because there is nothing there — not because extraction failed —
 * and treating that as uncovered would make every step near the finish re-probe a
 * region already known to be empty. So when the ask ran past the end, the claim is
 * kept. lastMarkableTime is what keeps a mark out of it.
 */
export function coveredWindow(
  asked: FrameWindow,
  found: number[],
  durationSec?: number,
): FrameWindow {
  if (!found.length) {
    // Nothing came back, so nothing is known. An empty window claims no coverage
    // rather than claiming the whole ask.
    return { from: asked.from, to: asked.from };
  }
  const lo = Math.min(...found);
  const hi = Math.max(...found);
  const end = durationSec && durationSec > 0 ? durationSec : Infinity;
  return {
    from: Math.max(asked.from, lo),
    to: asked.to >= end ? Math.max(asked.to, hi) : Math.min(asked.to, hi),
  };
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
 * Is the WHOLE span probed, as one continuous window?
 *
 * THE BUG THIS EXISTS FOR, and it locked the marking screen permanently.
 *
 * probeGridAround decided whether to re-probe by asking isCovered about the two
 * EDGES of the region it needed — centre-margin and centre+margin — and took two
 * yeses as meaning everything between them was covered. Windows are merged and
 * non-overlapping, so that holds right up until the mark lands in a GAP narrower
 * than 2*margin. Then both edges sit in the windows either side, the middle sits in
 * the hole, and the early exit fires on a point the grid cannot resolve.
 *
 * Reproduced offline on a 15s clip: windows [0, 14.5667] and [14.6667, 15.2333],
 * a 0.1000s gap against a 0.2000s span. Both edges covered, the centre not. markAt
 * returns null because frameIndexAt refuses an uncovered point, the readout sits on
 * SNAPPING, and every later release repeats the same test and skips the same probe.
 * Not slow — permanently stuck, until the clip is reloaded.
 *
 * CLIP LENGTH IS WHY IT WAS INTERMITTENT, and it is geometry rather than cost. A
 * probe window is a fixed number of FRAMES, so its width in seconds is fixed too.
 * Releases on a long clip are spread over more seconds, so consecutive windows need
 * not overlap and a residual gap can survive between them and the window made at
 * load near the end. On a short clip every release overlaps its neighbours, the
 * windows merge into one, and there is no gap to land in.
 *
 * Sampling two points can never answer a question about an interval. Asking which
 * window contains the span can, because merging guarantees at most one does.
 */
export function spanCovered(grid: FrameGrid, from: number, to: number): boolean {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  return grid.windows.some((w) => lo >= w.from - 1e-9 && hi <= w.to + 1e-9);
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

/**
 * Why a clip cannot be timed yet, in the coach's words, or null when it can.
 *
 * A DISABLED CONTROL THAT SAYS NOTHING IS A BROKEN ONE. Keep was gated on `timing`,
 * which is null whenever either mark fails to resolve — and the screen said nothing
 * at all, so a permanently stuck grid and a mark parked one frame past the end
 * looked identical: a button that did not respond. It cost a device session and two
 * wrong diagnoses to find out which.
 *
 * The distinctions are the ones that name different causes. Nothing read at all is a
 * decode or permission problem; one mark unresolved is a position problem and the
 * coach can fix it by moving that handle.
 */
export function whyNotTimeable(o: {
  frameCount: number;
  startResolved: boolean;
  finishResolved: boolean;
}): string | null {
  if (o.startResolved && o.finishResolved) return null;
  if (o.frameCount === 0) {
    return 'No frames could be read from this clip, so there is nothing to time. Try loading it again.';
  }
  if (!o.startResolved && !o.finishResolved) {
    return 'Neither mark is on a readable frame yet. Move a handle to probe that part of the clip.';
  }
  // WORDED FOR AFTER THE RETRY. The screen only reaches these once probeToResolve
  // has probed around the mark AND once past it, so "not readable yet" is no longer
  // one of the possibilities — extraction is failing in that region. Saying "move it
  // slightly" as the first response was wrong twice over: it fired during every
  // ordinary drag, when the answer was simply "not yet", and it asked the coach to
  // do by hand what the app should have done by probing.
  if (!o.startResolved) {
    return 'The start mark is on a frame this clip will not read back, even after looking again. Move it a little, or pick a different moment.';
  }
  return 'The finish mark is on a frame this clip will not read back, even after looking again. Move it a little, or pick a different moment.';
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
 * Refuses to leave the probed region rather than extrapolating by 1/fps.
 *
 * The original reason given was that iPhone clips are "routinely" variable rate.
 * That claim is now unsupported: with isVariableRate finally reporting something
 * real, every clip tested — including one shot deliberately in poor light to
 * provoke dropped frames — has come back constant. Modern iPhones appear to hold
 * their capture rate far better than the assumption allowed.
 *
 * The refusal stands anyway, for a reason that does not depend on it: a FAILED
 * extraction leaves exactly the same hole a dropped frame would, and that happens
 * regardless of frame rate. Extrapolating by 1/fps across either one produces a
 * timestamp for a frame nobody observed.
 */
export function stepFrames(grid: FrameGrid, t: number, delta: number): VideoMark | null {
  const i = frameIndexAt(grid, t);
  if (i === null) return null;
  const j = i + delta;
  if (j < 0) return null;
  const from = grid.frames[i];
  const to = grid.frames[j];
  if (from === undefined || to === undefined) return null;
  // SAME ISLAND, or it is not a step.
  //
  // `i + delta` is an index into a FLAT array built from disjoint windows, so
  // adding to it walks off the end of one island and into the next — which is a
  // different part of the clip, often many seconds away. frameDurAt alone does not
  // catch it: it checks that the LANDING frame has a successor in its own window,
  // and a frame in the middle of the next island passes that happily.
  //
  // Reachable, not theoretical. The step worker coalesces rapid presses into one
  // delta, so a held arrow produces a delta of five or ten. Measured on a grid with
  // a head and a tail window: +3 was correctly refused at the window edge, and +4
  // silently jumped twenty seconds down the clip. The refusal that should stop you
  // is bypassed by pressing HARDER, which is the worst possible shape for this.
  const wi = windowContaining(grid, from);
  const wj = windowContaining(grid, to);
  if (!wi || !wj || wi.from !== wj.from || wi.to !== wj.to) return null;
  const dur = frameDurAt(grid, j);
  if (dur === null) return null;
  return { pts: to, frameDurSec: dur };
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
 *
 * 'recorded' is the opposite of 'unknown' and that is the whole reason it exists.
 * A clip this app recorded has no photo-library asset either — but it needs no
 * asking, because we set the capture rate and wrote the file. There is no rendered
 * version to be handed instead of the original, because there is no edit and no
 * Photos round trip. Folding it into 'unknown' would attach "this cannot be checked
 * for slow motion" to the one kind of clip whose rate is not in doubt, on the happy
 * path, every time.
 */
export type TimeScale = 'normal' | 'slow-motion' | 'time-lapse' | 'unknown' | 'recorded';

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
  // 'recorded' and 'normal' both fall through to silence. Deliberately no warning
  // for a clip we recorded: we chose the rate, and a caveat on the path the coach
  // takes forty times a session is a caveat they stop reading.
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
 * gate's, flipping timeSource to 'video' — a review clip silently reclassifying a
 * gate-timed run.
 *
 * That used to mean the run MOVED to a different chart. Since gate and video share
 * a series it no longer does, and the damage is worse for being quieter: the run
 * would keep its position and acquire startPts, endPts, fps and a quantSdMs
 * describing frames its time was never read from. A wrong marker is visible; a
 * fabricated provenance is not.
 */
export type VideoRunFacts = {
  startPts: number;
  endPts: number;
  /** measured, never nominal */
  fps: number;
  /** One whole frame at the coarser end, in ms. See timeFromMarks. */
  errorMs: number;
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
    errorMs: f.errorMs,
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
      // errorMs FIRST, quantSdMs as the fallback. Rows written before the figure
      // changed keep the statistical spread they were saved with — they are not
      // recomputed, and reading them under the new name would silently relabel a
      // standard deviation as a frame period.
      errorMs: Number.isFinite(v.errorMs)
        ? v.errorMs
        : Number.isFinite(v.quantSdMs)
          ? v.quantSdMs
          : 0,
    };
  } catch {
    return null;
  }
}
