// What the camera must prove before a recording is allowed to become a time.
//
// Pure — no VisionCamera, no React, no filesystem. The recording SCREEN owns the
// session; this owns the rule, so the rule can be tested without a camera and
// cannot drift into a UI callback where nobody looks at it.
//
// THE FAILURE THIS EXISTS FOR. A camera asked for 240fps can answer in three
// places, and they can all disagree:
//
//   device.supportsFPS(240)        what the hardware CLAIMS
//   config.selectedFPS             what the session RESOLVED to
//   measured from the frames       what the file CONTAINS
//
// The spike proved the first two can be right while the third is wrong — that is
// why it was built three-layered. A camera that silently negotiates down to 30 and
// hands back a file the app times as 240 does not produce an error. It produces a
// plausible number that is eight times too fast, written to a run, charted as a
// personal best, and indistinguishable afterwards from a real one.
//
// So the rule is: a recording is timeable only when the layer BELOW the one you
// trusted agrees with it, and the file always wins.

/** How far a measured rate may sit from the requested one and still be that rate.
 *  Ten per cent — wide enough for 239.467 to read as 240, narrow enough that a
 *  negotiated fallback to 120 or 30 cannot hide inside it. */
export const FPS_TOLERANCE = 0.1;

/**
 * The default capture rate, and it is 120 rather than 240 on purpose.
 *
 * At 120fps a mark carries +/-3.4ms of quantisation against a body-part bias of
 * roughly 37ms — eleven times inside the error we cannot remove. 240fps halves that
 * to +/-1.7ms, which buys precision the method cannot use, for twice the frames.
 *
 * It is a DEFAULT, not a limit. 240 stays available for anyone who wants it; what
 * it stops being is the thing you get without choosing.
 */
export const DEFAULT_FPS = 120;

/** Offered rates, slowest first. 30 is present as a control rather than as a
 *  serious option — its +/-13.6ms is only 2.7x inside the bias. */
export const CAPTURE_RATES = [30, 60, 120, 240] as const;

// ---------------------------------------------------------------------------
// 60fps DOES NOT HOLD ON THE TEST DEVICE, AND THE MECHANISM IS NOT KNOWN.
//
// Measured on iPhone18,3 / iOS 26.6: the session reports it settled on 60, layer 2
// passes, and the file measures 30. Layer 3 refuses it, correctly — this is exactly
// the failure the three layers exist for, caught in the wild.
//
// 30, 120 and 240 all hold on the same device. Only 60 degrades.
//
// One hypothesis was offered and the device data killed it. The idea was that 60
// might be the only offered rate sharing a capture format with a lower one, so the
// only one able to silently fall back. The device reports:
//
//     fps ranges    1-60, 1-30, 1-240, 1-120
//
// Every rate is a wide range including 30. 120 and 240 are 1-120 and 1-240, not the
// point ranges the hypothesis needed. So format-sharing cannot explain why only 60
// degrades, and no second story is offered here.
//
// This is recorded the same way the probe-cost shape is: an observation that
// reproduces, with the mechanism marked UNIDENTIFIED rather than guessed at. What is
// established is that the rate is unreliable on this hardware, that layer 3 catches
// it, and that nothing depends on 60 — DEFAULT_FPS is 120 and it holds.
// ---------------------------------------------------------------------------

export type CaptureVerdict =
  | { ok: true; fps: number; warn: string | null }
  | { ok: false; reason: string };

/**
 * Layer 1 and 2, checked BEFORE recording starts.
 *
 * Refuses rather than warns, and refuses BEFORE rather than after, because the
 * alternative is discovering at the marking screen that the footage cannot be
 * timed — by which point the rep has been run and cannot be run again.
 */
export function acceptSession(
  requestedFps: number,
  deviceSupports: boolean,
  selectedFps: number | null | undefined,
): CaptureVerdict {
  if (!deviceSupports) {
    return {
      ok: false,
      reason:
        `This camera does not offer ${requestedFps}fps. Pick a lower rate — the times stay ` +
        'honest, they just carry a wider margin.',
    };
  }
  if (selectedFps == null) {
    return {
      ok: false,
      reason:
        'The camera did not report what frame rate it settled on, so there is no way to ' +
        'know whether the recording can be timed. Nothing was recorded.',
    };
  }
  if (Math.abs(selectedFps - requestedFps) > requestedFps * FPS_TOLERANCE) {
    return {
      ok: false,
      reason:
        `Asked for ${requestedFps}fps and the camera settled on ${Math.round(selectedFps)}. ` +
        'Recording at a rate you did not choose would put a time on screen that looks ' +
        'right and is not.',
    };
  }
  return { ok: true, fps: selectedFps, warn: null };
}

/**
 * Layer 3, checked AFTER recording, against the frames themselves.
 *
 * `measuredFps` comes from the probed grid — the median gap between frames that
 * were observed as neighbours. It is the only one of the three layers that is
 * evidence rather than intent, so it overrules both of the others.
 *
 * A null measurement is not a pass. Too few frames to measure means the clip could
 * not be read, and a clip that cannot be read cannot be timed.
 */
export function acceptRecording(
  requestedFps: number,
  selectedFps: number | null | undefined,
  measuredFps: number | null,
): CaptureVerdict {
  if (measuredFps == null || !(measuredFps > 0)) {
    return {
      ok: false,
      reason:
        'The recording could not be read back frame by frame, so its frame rate is unknown ' +
        'and no time can be taken from it. The video is kept.',
    };
  }
  if (Math.abs(measuredFps - requestedFps) > requestedFps * FPS_TOLERANCE) {
    const settled = selectedFps == null ? 'reported nothing' : `reported ${Math.round(selectedFps)}`;
    return {
      ok: false,
      reason:
        `This file measures ${measuredFps.toFixed(1)}fps, not the ${requestedFps} it was ` +
        `recorded at — the session ${settled}. A time marked from it would be wrong by that ` +
        'ratio. The video is kept as review footage.',
    };
  }
  return { ok: true, fps: measuredFps, warn: null };
}

/**
 * Both layers, in the order they happen, for the one caller that does the whole
 * thing. Kept as a named function so "did we check?" has a single answer.
 */
export function acceptCapture(
  requestedFps: number,
  deviceSupports: boolean,
  selectedFps: number | null | undefined,
  measuredFps: number | null,
): CaptureVerdict {
  const session = acceptSession(requestedFps, deviceSupports, selectedFps);
  if (!session.ok) return session;
  return acceptRecording(requestedFps, selectedFps, measuredFps);
}
