// Getting frames out of a clip, at the only batch size that works.
//
// expo-video's generateThumbnailsAsync takes an array, but ANY array longer than
// one fails with AVErrorDecodeFailed. Measured on device across both codecs, both
// dynamic ranges, every spacing and every maxSize: n=1 always succeeds, n>1 never
// does. The cause is in expo-video's own Swift — the AVAssetImageGenerator is a
// local whose last use is the `images(for:)` call, so ARC can release it while the
// async sequence is still being consumed, and the generator cancels pending work
// on dealloc. The first image lands before teardown; the rest die. Five calls made
// CONCURRENTLY all succeed, which is what rules out resource contention.
//
// So: one time per call, fanned out. Everything here exists to make that fast
// enough to feel interactive.
//
// The other measured fact shaping this: there is NO decode reuse between calls. A
// neighbouring frame costs the same as one a minute away (27.7ms scattered vs
// 29.3ms consecutive), because expo-video builds a fresh generator per call and
// each one decodes from the preceding keyframe. Stepping is therefore exactly as
// expensive as scrubbing, which is why the grid is probed in windows rather than
// one frame at a time as the coach steps.

import type { VideoPlayer } from 'expo-video';

import {
  FRAME_FAN_OUT,
  alignedProbes,
  chunk,
  filmstripTimes,
  gapProbes,
  ingestFrames,
  markAt,
  coveredWindow,
  spanCovered,
  type FrameGrid,
} from './timing';

/**
 * Frames probed either side of an anchor.
 *
 * Named because probeToResolve has to step PAST a window to extend it, and the
 * distance that guarantees an overlap is a function of this number. Two places
 * deriving the same geometry from a literal 8 is how they drift apart.
 */
export const FRAMES_EITHER_SIDE = 8;

/** Grid probes discard the image and keep only actualTime, so they ask for the
 *  smallest useful decode. Tiles are displayed, so they get a real size. */
const PROBE_SIZE = 64;
const TILE_SIZE = 160;

export type Tile = { time: number; actualTime: number; ref: unknown };

/**
 * Run `jobs` with at most FRAME_FAN_OUT in flight.
 *
 * Not Promise.all over everything: a filmstrip for a long clip could be hundreds
 * of requests, and firing them all at once holds hundreds of decoded frames in
 * memory on a phone that is also running a video player.
 */
async function fanOut<T>(jobs: (() => Promise<T>)[]): Promise<T[]> {
  const out: T[] = [];
  for (const group of chunk(jobs, FRAME_FAN_OUT)) {
    out.push(...(await Promise.all(group.map((j) => j()))));
  }
  return out;
}

/**
 * One frame. Returns its true presentation timestamp, or null if the request
 * failed or fell outside the clip.
 *
 * A failure is returned, not thrown: a filmstrip that loses one tile at the very
 * end of a clip should show the rest, not collapse.
 */
async function oneFrame(
  player: VideoPlayer,
  time: number,
  maxSize: number,
): Promise<{ actualTime: number; ref: unknown } | null> {
  try {
    const [thumb] = await player.generateThumbnailsAsync([time], {
      // BOTH dimensions. getMaxSize() builds CGSize(maxWidth, maxHeight) with each
      // defaulting to 0, so passing one alone yields a zero dimension.
      maxWidth: maxSize,
      maxHeight: maxSize,
    });
    return thumb ? { actualTime: thumb.actualTime, ref: thumb } : null;
  } catch {
    return null;
  }
}

/**
 * Extend the frame grid around `centre`, if it is not already covered.
 *
 * Returns the grid unchanged when the region is known — the whole point of
 * tracking windows is that re-probing costs real time (there is no cache and no
 * decode reuse) and a scrubber revisits the same neighbourhood constantly.
 */
export async function probeGridAround(
  player: VideoPlayer,
  grid: FrameGrid,
  centre: number,
  frameDurSec: number,
  framesEitherSide = FRAMES_EITHER_SIDE,
  /**
   * How much coverage is REQUIRED before this is a no-op, as opposed to how much
   * is fetched when it is not.
   *
   * These were the same number, and that made stepping pay a full probe on every
   * other press: a probe centred on C covers to C+9 frames, so stepping to C+1
   * still needed C+9 and just fitted, and C+2 needed C+10 and did not. Read-ahead
   * is the whole point of fetching a window — requiring only a couple of frames
   * of margin turns one probe into roughly seven free steps.
   */
  requiredEitherSide = 2,
  /**
   * Probe even when the region reads as covered.
   *
   * For probeToResolve ONLY, and it exists because a window can claim more than its
   * frames reach: ingestFrames records the range that was ASKED about, and failed
   * extractions leave holes under it. A mark on the last surviving frame before such
   * a hole is covered, unresolvable, and — without this — unprobeable, because the
   * early exit keeps saying the region is already known.
   */
  force = false,
): Promise<{ grid: FrameGrid; ms: number; calls: number }> {
  const t0 = Date.now();
  // ONE FRAME MORE THAN ASKED FOR, on each side.
  //
  // Coverage is not the same as usability. The last frame inside a probed window
  // has no successor within that window, so its duration is unknown and markAt
  // refuses it — correctly. That makes the RESOLVABLE region one frame narrower
  // than the covered one at each end, and checking plain coverage let the early
  // exit fire while the coach was standing on the unusable edge: the probe was
  // skipped as unnecessary, the step then found no frame, and forward stepping
  // stalled one frame short of the window with nothing willing to extend it.
  //
  // AND THE SPAN IS ASKED ABOUT AS A SPAN. This read
  //
  //     isCovered(centre - margin) && isCovered(centre + margin)
  //
  // which samples the two ENDS and infers the middle. That inference is false
  // exactly when the mark lands in a gap narrower than 2*margin: both edges are in
  // the windows either side, the centre is in the hole, the probe is skipped, and
  // markAt can never resolve the point — permanently, because every later release
  // runs the same test and skips the same probe. It was the "stuck on SNAPPING"
  // lock, and it needed a long clip only because window spacing is what decides
  // whether such a gap can exist. See spanCovered.
  const margin = (requiredEitherSide + 1) * frameDurSec;
  if (!force && spanCovered(grid, centre - margin, centre + margin)) {
    return { grid, ms: 0, calls: 0 };
  }

  // One call to learn the PHASE of the frame grid. Without a real timestamp to
  // anchor to you have to oversample to be sure of hitting every frame; with one
  // you can aim at frame centres and spend a single call per frame.
  const anchor = await oneFrame(player, centre, PROBE_SIZE);
  if (!anchor) return { grid, ms: Date.now() - t0, calls: 1 };

  const { window, times } = alignedProbes(
    anchor.actualTime,
    frameDurSec,
    framesEitherSide,
    framesEitherSide,
    // The clip's length, so the tail is not probed past its own end. A finish mark
    // sits near the end by definition, which is exactly where the unbounded version
    // spent eight extractions re-fetching the last frame.
    player.duration,
  );
  const results = await fanOut(times.map((t) => () => oneFrame(player, t, PROBE_SIZE)));
  const found = results.filter((r): r is { actualTime: number; ref: unknown } => r !== null);
  const times_found = [anchor.actualTime, ...found.map((r) => r.actualTime)];
  // CLAIM ONLY WHAT CAME BACK. Recording the asked range instead is what left holes
  // under covered spans, and a covered span with no frames in it is a mark that can
  // never resolve and will never be probed again. See coveredWindow.
  let next = ingestFrames(grid, coveredWindow(window, times_found, player.duration), times_found);
  let calls = 1 + times.length;

  // Repair only the holes. On a constant-rate clip there are none and this costs
  // nothing; on a variable-rate one it fills what the alignment drifted past.
  const holes = gapProbes(next, frameDurSec);
  if (holes.length) {
    const filled = await fanOut(holes.map((t) => () => oneFrame(player, t, PROBE_SIZE)));
    calls += holes.length;
    const got = filled.filter((r): r is { actualTime: number; ref: unknown } => r !== null);
    if (got.length) {
      const repaired = got.map((r) => r.actualTime);
      next = ingestFrames(next, coveredWindow(window, repaired, player.duration), repaired);
    }
  }

  return { grid: next, ms: Date.now() - t0, calls };
}

/**
 * Probe around `t`, and if the mark still will not resolve, probe once PAST it.
 *
 * WHY THIS IS WIDENING AND NOT SNAPPING, which was the design decision:
 *
 * A mark fails to resolve when its frame is the LAST one in its probed window. The
 * successor is across an unprobed gap, so the frame's DURATION is unknown, and
 * markAt refuses rather than compute an error bar from a length nobody measured.
 * That refusal is correct and stays.
 *
 * But the cure for a missing measurement is to take the measurement. Probing past
 * the edge gives that frame a real successor, and the duration that comes back is
 * measured like every other. Snapping the mark to the nearest resolvable frame
 * would instead move it silently — the coach put the handle on a frame, and
 * relocating it changes the time being recorded without saying so, at 8ms a frame
 * at 120fps. It would also HIDE the gap rather than fill it, so the next mark in
 * that region hits the same edge.
 *
 * ONCE, and bounded. A second failure is not an edge any more: it means extraction
 * genuinely fails in that region, and probing further would be an unbounded search
 * for frames that are not coming. `resolved: false` is the caller's cue to say so.
 *
 * The one case widening can never fix is the clip's FINAL frame — nothing follows
 * it to measure. That is handled before it arises, by lastMarkableTime keeping the
 * handle short of it: an unresolvable position is better made unreachable than
 * repaired afterwards.
 */
/** The last known frame at or before `t`, or null when there is none. */
function lastFrameAtOrBefore(grid: FrameGrid, t: number): number | null {
  let best: number | null = null;
  for (const f of grid.frames) {
    if (f <= t + 1e-9) best = f;
    else break;
  }
  return best;
}

export async function probeToResolve(
  player: VideoPlayer,
  grid: FrameGrid,
  t: number,
  frameDurSec: number,
): Promise<{ grid: FrameGrid; ms: number; calls: number; resolved: boolean }> {
  const first = await probeGridAround(player, grid, t, frameDurSec);
  if (markAt(first.grid, t)) return { ...first, resolved: true };

  // FROM THE EDGE FRAME, not from t, and FORCED.
  //
  // Both halves were wrong in the first version and the test caught them. Aiming a
  // fixed distance past `t` lands wherever the over-claiming window still says
  // "covered", so the second probe early-exited too and did nothing — zero calls,
  // still unresolved. And aiming past the window's END would fill from there,
  // leaving the gap between the edge frame and the new frames unprobed while the
  // merged window claimed it: markAt would then resolve with a "frame duration"
  // spanning the hole. That is the fabrication this whole design refuses.
  //
  // Anchoring FRAMES_EITHER_SIDE past the last known frame puts the new window's
  // lower half directly on top of it, so the frames come back CONTIGUOUS with the
  // edge frame and the successor it gains is a real neighbour one frame away.
  const edge = lastFrameAtOrBefore(first.grid, t);
  const from = edge ?? t;
  const second = await probeGridAround(
    player,
    first.grid,
    from + FRAMES_EITHER_SIDE * frameDurSec,
    frameDurSec,
    FRAMES_EITHER_SIDE,
    2,
    true,
  );
  return {
    grid: second.grid,
    ms: first.ms + second.ms,
    calls: first.calls + second.calls,
    resolved: markAt(second.grid, t) !== null,
  };
}

/**
 * Resolve the mark that just moved, and then the one that did NOT.
 *
 * THE BUG THIS EXISTS FOR, and it is the reason three previous fixes each moved the
 * symptom instead of removing it.
 *
 * A settle probes ONE position: the handle the coach just let go of. If some other
 * settle earlier in the session left the OTHER mark unresolvable — a failed
 * extraction, a hole probeToResolve could not reach past — nothing ever looks at it
 * again. The coach can drag the first handle twenty more times and every one of those
 * settles reports `resolved: true` after a full probe, because it is reporting on the
 * mark under their finger. Meanwhile `timing` is null, Keep stays disabled, and the
 * readout sits on SNAPPING with the diagnostic insisting everything resolved.
 *
 * That is exactly the device signature: `probe 239ms/18 start:ok finish:NULL`. A full
 * eighteen-call probe, no UNRESOLVED, and a mark that cannot be timed. The probe was
 * never aimed at the mark that was failing.
 *
 * Reproduced offline against a player with a 5% unreadable-frame rate: one settle
 * comes back `resolved: false` and strands a mark, and every settle after it on the
 * other handle reads `res=true, other NULL` until the coach happens to touch the
 * stranded handle again. It recovers only by luck.
 *
 * WHY IT SURFACED WHEN THE SEED WAS FIXED. `framesEitherSide` is a count of FRAMES,
 * so a window's width in SECONDS is proportional to frameDurSec. While loadClipInto
 * was reading the previous clip's rate, the seed was one rate too coarse (or the 1/30
 * fallback), and every probed window was two to eight times wider in seconds than it
 * should have been. Wide windows from separate settles overlap and merge, so a hole
 * left by a failed extraction was almost always covered by a neighbouring window's
 * frames and markAt found a successor anyway. Measured on one clip, same failures,
 * same drags, varying only the seed: 1/240 gives a 61ms mean window and 5 of 20
 * settles show a NULL mark; 1/120 gives 498ms and 0 of 20; 1/30 gives 955ms and 0 of
 * 20. The stale seed was not preventing this bug, it was hiding it.
 *
 * The second probe costs NOTHING on the happy path — markAt is an array scan, and it
 * is only when the other mark is genuinely unresolvable that an extraction is spent.
 *
 * `movedResolved` is recomputed from the FINAL grid rather than carried over from the
 * first probe, so the flag always describes the grid actually handed back. That is a
 * consistency choice and NOT a guard against a real hazard: the guard it was first
 * written as claimed that adding frames can unresolve a mark, and that claim is
 * false. A mutation replacing the recompute with the carried-over answer survived the
 * whole suite, which was the correct signal — a randomised search over 73,213 grids
 * where a mark resolved found no ingest that made it stop. Windows merge and only
 * ever grow, so a nearer frame is always inside a window that already reaches its
 * successor. Written down because the next person to see two ways of computing the
 * same flag deserves to know they agree, rather than inventing a reason they might
 * not.
 */
export async function resolveMarks(
  player: VideoPlayer,
  grid: FrameGrid,
  moved: number,
  other: number,
  frameDurSec: number,
): Promise<{
  grid: FrameGrid;
  ms: number;
  calls: number;
  movedResolved: boolean;
  otherResolved: boolean;
}> {
  const a = await probeToResolve(player, grid, moved, frameDurSec);
  if (markAt(a.grid, other)) {
    return {
      grid: a.grid,
      ms: a.ms,
      calls: a.calls,
      movedResolved: a.resolved,
      otherResolved: true,
    };
  }
  const b = await probeToResolve(player, a.grid, other, frameDurSec);
  return {
    grid: b.grid,
    ms: a.ms + b.ms,
    calls: a.calls + b.calls,
    movedResolved: markAt(b.grid, moved) !== null,
    otherResolved: b.resolved,
  };
}

/**
 * Tiles for a filmstrip covering [from, to].
 *
 * Only ever asked for the VISIBLE window. Clips are uncapped, and a ten-minute
 * clip has no business generating a tile per second up front.
 */
export async function filmstrip(
  player: VideoPlayer,
  from: number,
  to: number,
  count: number,
): Promise<Tile[]> {
  const times = filmstripTimes(from, to, count);
  const results = await fanOut(times.map((t) => () => oneFrame(player, t, TILE_SIZE)));
  const out: Tile[] = [];
  results.forEach((r, i) => {
    if (r) out.push({ time: times[i]!, actualTime: r.actualTime, ref: r.ref });
  });
  return out;
}

/**
 * Read the clip's nominal frame duration, for seeding probe windows.
 *
 * Nominal because it is only a seed: AVAssetTrack.nominalFrameRate is an average,
 * and the real spacing comes back from the grid. A clip reporting 25.5 is telling
 * you it is variable, not that its frames are 39.2ms apart.
 */
export function nominalFrameDur(player: VideoPlayer): number {
  const track = player.videoTrack ?? player.availableVideoTracks[0] ?? null;
  const fps = track?.frameRate && track.frameRate > 0 ? track.frameRate : 30;
  return 1 / fps;
}

/**
 * Put a clip on a player and read back ITS length and rate — not the last one's.
 *
 * THE BUG THIS EXISTS FOR, confirmed on device from two symptoms at once.
 *
 * `replaceAsync` resolves before `duration` and `videoTrack` reflect the new item.
 * Polling them straight afterwards reads whatever the PREVIOUS clip left behind, and
 * both of those numbers are load-bearing:
 *
 *   duration   A 0.7s recording reported 7 seconds — the clip before it — so the
 *              finish handle was clamped into space the clip does not contain and
 *              the second mark could not be reached at all.
 *   frameDur   Worse, because it is silent. The probe aims at frame centres using
 *              this seed, so a seed one rate BELOW the truth samples every second
 *              frame and measuredFps reports exactly half. That is the "60 measures
 *              30, 120 measures 60" ladder: not a camera degrading, a probe
 *              measuring the previous clip's grid. Layer 3 then refuses a perfectly
 *              good recording and blames the hardware, which it did, for days.
 *
 * waitForClip alone could not fix it and did not: it waits for duration > 0 and a
 * readable track, and the STALE values satisfy both instantly. Waiting harder on a
 * value that is already wrong never helps.
 *
 * So the source is CLEARED first and the clear is confirmed. After replaceAsync(null)
 * the player must report no duration; only then is any duration > 0 known to belong
 * to the clip just handed over. It costs one extra round trip and it is the only
 * version of this that cannot read a previous clip's numbers.
 */
export async function loadClipInto(
  player: VideoPlayer,
  uri: string,
  timeoutMs: number,
): Promise<{ durationSec: number; frameDurSec: number; tracked: boolean }> {
  await player.replaceAsync(null);
  // CONFIRM THE CLEAR ON BOTH FACTS, not just the length.
  //
  // Waiting only for duration to reach zero was not enough, and the offline fixture
  // caught it: the track settles AFTER the duration, so a player can report the new
  // clip's length while videoTrack still describes the previous one. That leaves the
  // seed stale — which is the whole "60 measures 30" ladder — with the duration
  // looking perfectly correct, so nothing on screen would have hinted at it.
  //
  // Bounded, because a player that will not let go is a broken player and hanging
  // here would be worse than proceeding with a warning.
  const clearBy = Date.now() + timeoutMs;
  while (((player.duration || 0) > 0 || hasFrameRate(player)) && Date.now() < clearBy) {
    await new Promise((r) => setTimeout(r, 25));
  }
  await player.replaceAsync(uri);
  return waitForClip(player, timeoutMs);
}

/** Whether the clip's own frame rate is readable YET. See loadClipInto. */
export function hasFrameRate(player: VideoPlayer): boolean {
  const track = player.videoTrack ?? player.availableVideoTracks[0] ?? null;
  return !!(track?.frameRate && track.frameRate > 0);
}

/**
 * Wait until the clip can answer BOTH questions: how long is it, and how fast.
 *
 * WAITING FOR DURATION ALONE WAS THE BUG, and it is the second time this exact
 * shape has bitten this file. `frameDur` was once a useMemo that ran before the
 * tracks existed, so nominalFrameDur fell back to 30 and a 24fps clip was probed on
 * a 30fps grid for its whole life. That was fixed by moving the read after an await
 * — but the await was for `duration`, which arrives FIRST. The track can still be
 * missing, the fallback still fires, and the fix was incomplete.
 *
 * Why it is worse than it looks: the probe aims at frame centres using this seed, so
 * a 1/30 seed on a 60fps clip hits every SECOND frame, and measuredFps then reports
 * 30. The measurement is not independent of the seed — it can only find frames it
 * aimed at — so layer 3 refuses a perfectly good 60fps recording and blames the
 * camera. A false-refusal generator on exactly the clips layer 3 exists to check.
 *
 * `tracked: false` means the rate never became readable. The caller must NOT treat
 * whatever the grid then measures as evidence: it is a measurement of the guess.
 */
async function waitForClip(
  player: VideoPlayer,
  timeoutMs: number,
): Promise<{ durationSec: number; frameDurSec: number; tracked: boolean }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const d = player.duration || 0;
    const tracked = hasFrameRate(player);
    if (d > 0 && tracked) return { durationSec: d, frameDurSec: nominalFrameDur(player), tracked: true };
    if (Date.now() >= deadline) {
      return { durationSec: d, frameDurSec: nominalFrameDur(player), tracked };
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}
