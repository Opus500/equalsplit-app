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
  isCovered,
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
): Promise<{ grid: FrameGrid; ms: number; calls: number }> {
  const t0 = Date.now();
  // Covered already: nothing to learn, and a scrubber revisits the same
  // neighbourhood constantly, so this early exit is most of why dragging is cheap.
  if (isCovered(grid, centre - framesEitherSide * frameDurSec) &&
      isCovered(grid, centre + framesEitherSide * frameDurSec)) {
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
