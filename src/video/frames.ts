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
  spanCovered,
  type FrameGrid,
} from './timing';

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
  framesEitherSide = 8,
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
  if (spanCovered(grid, centre - margin, centre + margin)) {
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
  let next = ingestFrames(grid, window, [anchor.actualTime, ...found.map((r) => r.actualTime)]);
  let calls = 1 + times.length;

  // Repair only the holes. On a constant-rate clip there are none and this costs
  // nothing; on a variable-rate one it fills what the alignment drifted past.
  const holes = gapProbes(next, frameDurSec);
  if (holes.length) {
    const filled = await fanOut(holes.map((t) => () => oneFrame(player, t, PROBE_SIZE)));
    calls += holes.length;
    const got = filled.filter((r): r is { actualTime: number; ref: unknown } => r !== null);
    if (got.length) next = ingestFrames(next, window, got.map((r) => r.actualTime));
  }

  return { grid: next, ms: Date.now() - t0, calls };
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

/** Whether the clip's own frame rate is readable YET. See waitForClip. */
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
export async function waitForClip(
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
