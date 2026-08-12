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

/** Copy a picked clip into app storage. The picker's URI is temporary. */
export async function importClip(pickedUri: string): Promise<Clip> {
  const id = newClipId();
  const dir = clipDir(id);
  dir.create({ intermediates: true });

  const dest = clipFile(id, extensionOf(pickedUri));
  await new File(pickedUri).copy(dest);

  return { id, uri: dest.uri, bytes: dest.size ?? 0, importedAt: Date.now() };
}

/** Resolve a stored clip, or null if it is gone. */
export function getClip(id: string): Clip | null {
  const dir = clipDir(id);
  if (!dir.exists) return null;
  for (const entry of dir.list()) {
    if (entry instanceof File && entry.name.startsWith('clip')) {
      return { id, uri: entry.uri, bytes: entry.size ?? 0, importedAt: 0 };
    }
  }
  return null;
}

/** Every stored clip, newest first. Backs the list a coach deletes from. */
export function listClips(): Clip[] {
  const root = rootDir();
  if (!root.exists) return [];
  const out: Clip[] = [];
  for (const entry of root.list()) {
    if (!(entry instanceof Directory)) continue;
    const clip = getClip(entry.name);
    if (clip) out.push(clip);
  }
  // ids are base36 timestamps, so lexical order is chronological.
  return out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/**
 * Delete a clip and everything under it.
 *
 * Never touches the run. A video-timed run keeps its time, and Stage 1 explicitly
 * offers "discard the video, keep the time" — so a run whose clip is gone is a
 * normal state, not a broken one, and parseVideoRunJson's clipId is read as "look
 * here IF it is still there".
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
