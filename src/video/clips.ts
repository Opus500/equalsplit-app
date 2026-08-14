// Where imported clips live, and what they cost.
//
// "Videos live in the app, not the camera roll." The picker hands back a temp URI
// that does not survive the session, so an imported clip is copied into the app's
// DOCUMENT directory — not the cache directory, which iOS evicts under storage
// pressure. A run that references a clip iOS silently deleted would be worse than
// one that never had a video.
//
// There is deliberately NO tile cache here. A visible filmstrip window is 12-20
// tiles at ~24ms each with a fan of 8 — a couple of hundred milliseconds to
// rebuild — against megabytes per clip to store. That trade is bad, and keeping
// storage to the clip alone is what makes the size shown at the delete point
// honest: it is exactly what deleting reclaims, with nothing else to account for.

import { Directory, File, Paths } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { Asset, MediaSubtype } from 'expo-media-library';

import type { TimeScale } from './timing';

/** Everything lives under one directory so a clip is deleted by removing a folder. */
const ROOT = 'videos';

export type Clip = {
  id: string;
  /** file:// URI of the video itself */
  uri: string;
  bytes: number;
  /** when it was imported, epoch ms */
  importedAt: number;
};

/** Same shape as database.ts's ids: base36 time plus randomness. */
export function newClipId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function rootDir(): Directory {
  return new Directory(Paths.document, ROOT);
}

function clipDir(id: string): Directory {
  return new Directory(rootDir(), id);
}

/**
 * The clip's own file. The original extension is preserved rather than forced to
 * .mp4 — the import is a byte copy (Passthrough), and renaming a .MOV to .mp4
 * would be a lie that AVFoundation would then have to see through.
 */
function clipFile(id: string, extension: string): File {
  return new File(clipDir(id), `clip${extension}`);
}

function extensionOf(uri: string): string {
  const name = uri.split('?')[0]!.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '.mov';
}

/**
 * Headroom demanded on top of the clip's own size before a copy is attempted.
 *
 * A phone that finishes an import with nothing left is a phone that cannot then
 * write its own database. 50MB is roughly one 4K minute — enough to be a real
 * margin without refusing an import that would comfortably fit.
 */
const DISK_HEADROOM = 50 * 1024 * 1024;

/** Thrown when the copy would not fit. Carries the numbers so the message can. */
export class NotEnoughSpaceError extends Error {
  constructor(readonly needBytes: number, readonly freeBytes: number) {
    super(
      `This clip needs ${formatBytes(needBytes)} and only ${formatBytes(freeBytes)} is free.`,
    );
    this.name = 'NotEnoughSpaceError';
  }
}

/**
 * Copy a picked clip into app storage. The picker's URI is temporary.
 *
 * Checked BEFORE the copy and cleaned up AFTER a failure, because both halves
 * were missing and both fail in the same situation — a full phone. Without the
 * check the coach gets `NSFileWriteOutOfSpaceError` as a raw string; without the
 * cleanup the directory (and whatever FileManager managed to write into it)
 * survives, so a failed import silently consumes the space it just complained
 * about. The pre-flight is advisory, not a guarantee: something else can take the
 * space in between, which is exactly why the cleanup exists as well.
 */
export async function importClip(pickedUri: string): Promise<Clip> {
  const source = new File(pickedUri);
  const need = source.size ?? 0;
  if (need > 0) {
    const free = Paths.availableDiskSpace;
    if (Number.isFinite(free) && free < need + DISK_HEADROOM) {
      throw new NotEnoughSpaceError(need, free);
    }
  }

  const id = newClipId();
  const dir = clipDir(id);
  dir.create({ intermediates: true });

  try {
    const dest = clipFile(id, extensionOf(pickedUri));
    await source.copy(dest);
    return { id, uri: dest.uri, bytes: dest.size ?? 0, importedAt: Date.now() };
  } catch (e) {
    // Leave nothing behind. A half-written file is worse than no file: it looks
    // like a clip in the library, reports a plausible size, and fails to decode.
    try {
      if (dir.exists) dir.delete();
    } catch {
      // The original failure is the one worth reporting.
    }
    throw e;
  }
}

/**
 * What a pick came back as. A discriminated result rather than a nullable URI,
 * because "the coach cancelled" and "the coach refused access" need different
 * responses, and collapsing them into null loses that.
 */
export type PickResult =
  | {
      status: 'picked';
      uri: string;
      /**
       * Whether the clip's playback time is real time. Resolved here rather than
       * left to the caller, because it needs the photo-library asset behind the
       * file and that identity is only available at the moment of picking.
       */
      timeScale: TimeScale;
    }
  | { status: 'cancelled' }
  | { status: 'denied' };

/**
 * Ask iOS whether an asset is slow motion or time-lapse.
 *
 * iOS knows — it sets `PHAssetMediaSubtype.videoHighFrameRate` on a slo-mo capture
 * and `.videoTimelapse` on a time-lapse — and this is the only reliable signal.
 * The rendered file itself carries nothing that distinguishes it from an ordinary
 * clip of the same length, which is exactly why the problem is invisible.
 *
 * Returns 'unknown' rather than throwing or guessing. A clip picked from Files has
 * no PHAsset, `assetId` comes back null, and there is genuinely nothing to check.
 */
export async function timeScaleOf(assetId: string | null | undefined): Promise<TimeScale> {
  if (!assetId) return 'unknown';
  try {
    // The `ph://` prefix is REQUIRED and its absence fails silently. Asset's
    // constructor is `String(id.dropFirst("ph://".count))` — it removes five
    // characters unconditionally, whether or not the prefix is there. A bare
    // identifier therefore reaches PhotoKit with its first five characters gone
    // and simply matches no asset, so the check would come back 'unknown' for
    // every clip and quietly degrade to no checking at all.
    const subtypes = await new Asset(`ph://${assetId}`).getMediaSubtypes();
    if (subtypes.includes(MediaSubtype.HIGH_FRAME_RATE)) return 'slow-motion';
    if (subtypes.includes(MediaSubtype.TIME_LAPSE)) return 'time-lapse';
    return 'normal';
  } catch {
    // Includes Android, where media subtypes do not exist. Unknown, not normal:
    // claiming a clip is fine because we failed to ask is the one answer that
    // could produce a wrong time silently.
    return 'unknown';
  }
}

/** The refusal message, here beside the request it belongs to, so both entry
 *  points say the same thing. */
export const PHOTO_ACCESS_TITLE = 'Photo access needed';
export const PHOTO_ACCESS_MESSAGE = 'EqualSplit needs to read the clip you recorded.';

/**
 * Ask for a video from the photo library.
 *
 * ONE copy of these options, because two of them are load-bearing and neither
 * looks it. This call lived verbatim in both the marking screen and the attach
 * path with the reasoning recorded only in the first — which is precisely how a
 * flag that reads as gratuitous gets deleted from one of two copies, leaving the
 * bug in whichever route is exercised less.
 *
 * PASSTHROUGH copies the original bytes. Any other preset re-encodes, and a
 * re-encode normalises to a constant frame rate — quietly changing the frame
 * timings this whole feature exists to measure. It matters most on the marking
 * path, but a clip attached for review today may be marked properly tomorrow, and
 * it must not have been resampled in between.
 *
 * SHOULDDOWNLOADFROMNETWORK is REQUIRED with Passthrough, and is the one nobody
 * would guess. The Passthrough fast path streams the original resource through
 * PHAssetResourceManager, whose network access is bound to this flag rather than
 * to any of the picker's own settings — so with it false (the default) every clip
 * that is not fully local fails with PHPhotosError 3164. Including clips the coach
 * believes are on the phone, because iOS offloads them without asking.
 *
 * Deliberately shows no UI and imports nothing: this module owns storage, and a
 * storage module that raises alerts cannot be called from anywhere that needs to
 * handle a refusal differently.
 */
export async function pickVideo(): Promise<PickResult> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return { status: 'denied' };

  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['videos'],
    allowsEditing: false,
    videoExportPreset: ImagePicker.VideoExportPreset.Passthrough,
    shouldDownloadFromNetwork: true,
  });

  const asset = res.canceled ? null : (res.assets[0] ?? null);
  if (!asset?.uri) return { status: 'cancelled' };
  return { status: 'picked', uri: asset.uri, timeScale: await timeScaleOf(asset.assetId) };
}

/**
 * Resolve a stored clip, or null if it is gone.
 *
 * A ZERO-BYTE file counts as gone. It is not a clip that happens to be small —
 * it is what a copy interrupted by a crash or a full disk leaves behind, and
 * returning it would put a row in the library that shows a Play button opening a
 * player that can never load. "Missing" is already a state every caller handles
 * correctly; "present but undecodable" is not.
 *
 * Never throws. It is called from render-adjacent effects, and a filesystem error
 * on one clip must not take down the screen listing all of them.
 */
export function getClip(id: string): Clip | null {
  try {
    const dir = clipDir(id);
    if (!dir.exists) return null;
    for (const entry of dir.list()) {
      if (entry instanceof File && entry.name.startsWith('clip')) {
        const bytes = entry.size ?? 0;
        if (bytes <= 0) return null;
        return { id, uri: entry.uri, bytes, importedAt: 0 };
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Every stored clip, newest first. Backs the list a coach deletes from. */
export function listClips(): Clip[] {
  const out: Clip[] = [];
  try {
    const root = rootDir();
    if (!root.exists) return [];
    for (const entry of root.list()) {
      if (!(entry instanceof Directory)) continue;
      const clip = getClip(entry.name);
      if (clip) out.push(clip);
    }
  } catch {
    return out;
  }
  // ids are base36 timestamps, so lexical order is chronological.
  return out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/**
 * Remove clip directories holding nothing usable, and report how many.
 *
 * These are the residue of an import that died between creating the directory
 * and finishing the copy — a crash, a kill, a full disk. importClip now cleans
 * up after itself, so this exists for the cases it cannot reach (the process is
 * gone) and for directories left by builds before that cleanup existed.
 *
 * Deliberately narrow: it removes ONLY directories that contain no clip file, or
 * a clip file of zero bytes. Both are provably undecodable, so nothing a coach
 * could want is destroyed. Anything with real bytes in it is left alone, however
 * odd it looks — a clip that fails to play is still theirs to decide about.
 *
 * Returns the count rather than doing it silently: reclaimed space should be
 * something the screen can state, not something that happens behind the numbers.
 */
export function sweepBrokenClips(): number {
  let removed = 0;
  try {
    const root = rootDir();
    if (!root.exists) return 0;
    for (const entry of root.list()) {
      if (!(entry instanceof Directory)) continue;
      if (getClip(entry.name)) continue;
      try {
        entry.delete();
        removed += 1;
      } catch {
        // Leave it; it costs nothing and will be offered again next time.
      }
    }
  } catch {
    return removed;
  }
  return removed;
}

/**
 * Delete a clip and everything under it.
 *
 * Never touches the run. Stage 1 dropped "keep time only" — the clip always stays
 * with the run it was marked from — but the library exists precisely so a coach
 * can take that space back later, and the time survives when they do. So a run
 * whose clip is gone is a normal state, not a broken one, and runs.clip_id is
 * read as "look here IF it is still there".
 */
export function deleteClip(id: string): void {
  const dir = clipDir(id);
  if (dir.exists) dir.delete();
}

/** Total bytes across all stored clips — the honest figure for a storage line. */
export function totalBytes(): number {
  return listClips().reduce((sum, c) => sum + c.bytes, 0);
}

/** "7.3 MB". Sizes are shown so blind deletion is avoidable, so they round
 *  coarsely on purpose — nobody chooses by the third significant figure. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 100) return `${mb.toFixed(1)} MB`;
  return `${Math.round(mb)} MB`;
}
