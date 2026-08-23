// What a recording may consume, and what has to survive it.
//
// Pure — no camera, no filesystem, no React. clips.ts reads the disk and the
// recording screen applies the numbers; this owns the arithmetic so it can be
// tested without either, exactly as capture.ts owns the frame-rate rule.
//
// THE THING THIS DELIBERATELY IS NOT. Every draft of this guard began by
// multiplying a duration by a rate — "thirty seconds at 240fps is about 125MB, so
// demand that much free". The spike killed that. Three clips at identical 1080p120
// measured 2.3, 8.7 and 24.8 Mbps: a fifteen-fold spread from CONTENT alone, at one
// resolution and one frame rate, with length ruled out separately (240fps gave 262
// MB/min at 3s and 260 at 60s). A bitrate is a property of a scene, not of a
// setting. A projection built from one sample is a number with no error bar, quoted
// as though it had none.
//
// So nothing here predicts what a clip will cost. There are two bounds and both are
// enforced by the RECORDER rather than computed by us:
//
//   maxDuration   MAX_CLIP_MS, the safety rail.
//   maxFileSize   a byte BUDGET, cut from free space measured a moment earlier.
//
// The budget is not an estimate of the clip. It is a ceiling on what the clip is
// allowed to become, and the recorder stops when the file has actually reached it —
// no rate is involved at any point. That is the primary defence; the duration cap is
// the backstop for the case where the disk is huge and the phone is not.
//
// Both limits finalize the file cleanly. VisionCamera's contract is explicit that a
// recording ended by either limit is "fully written and usable", which is what makes
// a byte ceiling safe to lean on: hitting it costs a shorter clip, never a corrupt
// one, and never a rep that has to be run again.

/**
 * The longest recording, in milliseconds.
 *
 * GENEROUS ON PURPOSE, and a safety rail rather than a budget. A rep is a few
 * seconds; thirty is long enough that nobody meets it while filming a sprint, and
 * short enough that a phone left recording in a bag costs one clip instead of a
 * card. It exists for the pocket case, not for the coach.
 *
 * Handed to the recorder as maxDuration, NOT run as a setTimeout. A JS timer is
 * starved by a busy bridge and stops entirely when the app is backgrounded, which is
 * precisely the situation the rail is for — the one where nobody is watching.
 */
export const MAX_CLIP_MS = 30_000;

/**
 * Free space that must remain after a recording, in bytes.
 *
 * Five times the import path's DISK_HEADROOM, and the difference is the point. An
 * import copies a file whose size is KNOWN before the copy starts, so its headroom
 * only has to absorb what else the phone does meanwhile. A recording's size is not
 * knowable in advance at all, so this number is doing two jobs: keeping the phone
 * working, and standing in for an error bar nobody can compute.
 *
 * 250MB is roughly what iOS wants free to stay out of trouble — write its own
 * databases, finish a Photos sync, install nothing. A coach who ends a session on
 * less than that has a problem this app should not have helped cause.
 */
export const RECORD_RESERVE_BYTES = 250 * 1024 * 1024;

/**
 * The smallest budget worth starting a recording with, in bytes.
 *
 * Without a floor the guard degrades absurdly rather than refusing: at 251MB free
 * the arithmetic yields a 1MB ceiling, the recorder hits it in a fraction of a
 * second, and the coach has run a rep for nothing. Refusing before the rep is the
 * only useful answer.
 *
 * 40MB is the one number here informed by the measurements, and it is used ONLY to
 * decide refuse-or-allow — never shown, never presented as what a clip will cost. At
 * the dearest thing measured (250 MB/min at 240fps) it covers about ten seconds, and
 * a rep is five. Below it a recording is not worth the rep it would cost.
 */
export const MIN_RECORD_BUDGET_BYTES = 40 * 1024 * 1024;

export type SpaceVerdict =
  | {
      ok: true;
      /** Byte ceiling for the recorder, or null when free space is unreadable and
       *  the duration cap is the only bound left. */
      budgetBytes: number | null;
      warn: string | null;
    }
  | { ok: false; reason: string };

/**
 * Turn measured free space into a ceiling, or refuse.
 *
 * `freeBytes` must come from the disk, taken as close to the recording as possible —
 * it is measured, not remembered.
 *
 * AN UNREADABLE FIGURE IS ALLOWED THROUGH, which is the opposite of what capture.ts
 * does with a frame rate it cannot read, and the asymmetry is deliberate. There, not
 * knowing means a time might be wrong by a factor of eight and look right forever
 * after: silent, permanent, indistinguishable. Here, not knowing means the disk might
 * fill — loud, visible, and still bounded by MAX_CLIP_MS. One deserves a refusal; the
 * other deserves a warning and the backstop.
 */
export function budgetForRecording(freeBytes: number): SpaceVerdict {
  if (!Number.isFinite(freeBytes)) {
    return {
      ok: true,
      budgetBytes: null,
      warn:
        'This phone did not report how much space is free, so the recording is bounded by ' +
        `its ${Math.round(MAX_CLIP_MS / 1000)} second limit alone. Keep an eye on storage.`,
    };
  }

  const budget = Math.floor(freeBytes) - RECORD_RESERVE_BYTES;
  if (budget < MIN_RECORD_BUDGET_BYTES) {
    return {
      ok: false,
      reason:
        `There is not enough room to record. ${formatBytes(Math.max(0, Math.floor(freeBytes)))} ` +
        `is free, and EqualSplit keeps ${formatBytes(RECORD_RESERVE_BYTES)} clear so the phone ` +
        'stays usable. Delete some clips in Videos, or import a rep filmed elsewhere.',
    };
  }
  return { ok: true, budgetBytes: budget, warn: null };
}

/** Why a recording ended. Mirrors VisionCamera's RecordingFinishedReason rather than
 *  importing it, so this module stays free of the camera. */
export type RecordingEnd = 'stopped' | 'max-duration-reached' | 'max-file-size-reached';

/**
 * What to tell the coach when a recording ended by itself, or null when they stopped
 * it and there is nothing to say.
 *
 * BOTH AUTO-STOPS SAY THE CLIP IS COMPLETE, and that sentence is the whole reason
 * this function exists. A recording that halts on its own reads as a failure, and a
 * coach who believes the footage is truncated will re-run a rep that was captured
 * perfectly well. The file is finalized in both cases; only its length was decided by
 * something other than the finger.
 */
export function endedBecause(reason: RecordingEnd): string | null {
  if (reason === 'max-duration-reached') {
    return (
      `Recording stopped at the ${Math.round(MAX_CLIP_MS / 1000)} second limit. The clip is ` +
      'complete and ready to mark.'
    );
  }
  if (reason === 'max-file-size-reached') {
    return (
      'Recording stopped because the space set aside for it ran out. The clip is complete and ' +
      'ready to mark, just shorter than you asked for.'
    );
  }
  return null;
}

/**
 * A clip's cost, MEASURED — bytes off the file and seconds off the player.
 *
 * There is no per-minute figure here and there is not going to be one. A rate
 * computed from one clip is that clip's scene, and putting it on screen invites the
 * coach to multiply it by a session; the fifteen-fold spread above is what that
 * multiplication is worth. Two facts, both read from the thing itself.
 */
export function describeClip(bytes: number, seconds: number): string {
  if (!(bytes > 0)) return 'size unreadable';
  if (!(seconds > 0)) return formatBytes(bytes);
  return `${formatBytes(bytes)} · ${seconds.toFixed(2)}s`;
}

/**
 * "7.3 MB". Sizes are shown so blind deletion is avoidable, so they round coarsely
 * on purpose — nobody chooses by the third significant figure.
 *
 * Lives here rather than in clips.ts because the refusals above need it and clips.ts
 * cannot be imported without pulling in the filesystem and the picker. clips.ts
 * re-exports it, so its callers are unaffected.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 100) return `${mb.toFixed(1)} MB`;
  return `${Math.round(mb)} MB`;
}
