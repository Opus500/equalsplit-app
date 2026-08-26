// Recording a rep, and refusing to before the rep is run.
//
// A modal over the marking screen rather than a third pane, because recording is
// not a place you go — it is one of two ways a clip arrives, sitting beside Import
// and handing back the same Clip. Everything downstream (the filmstrip, the grid,
// the library, the share sheet) already treats the two identically; see the note
// at the top of clips.ts about why that was worth arranging.
//
// THE RULES ARE NOT HERE. capture.ts owns the frame-rate proof and storage.ts owns
// the disk arithmetic, both pure and both driven by their own verify scripts. This
// file is the session: it opens a camera, applies those verdicts at the two moments
// they can be applied, and shows what is happening. That split is the reason a rule
// as consequential as "refuse a negotiated 30fps" can be tested without a phone.
//
// WHERE EACH LAYER BITES, and why the order is the whole design:
//
//   layers 1+2   HERE, on the press, BEFORE the recording starts. A device that
//                cannot hold the rate and a session that settled somewhere else are
//                both knowable in advance, and the alternative is discovering it at
//                the marking screen — after the rep has been run and cannot be run
//                again.
//   the budget   HERE, on the press, from free space read a moment earlier.
//   layer 3      NOT here. It needs the frames, which means the probe, which means
//                the marking screen. It is applied there, against this recording's
//                requested and selected rates, and it overrules both of them.
//
// The microphone is never requested. A sprint is timed from frames, and a permission
// nobody uses is one the coach has to decline for no reason.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useVideoOutput,
  type CameraSessionConfig,
  type Recorder,
} from 'react-native-vision-camera';

import {
  CAPTURE_RATES,
  DEFAULT_FPS,
  acceptSession,
} from '../video/capture';
import {
  claimRecording,
  discardRecording,
  freeDiskBytes,
  formatBytes,
  newRecordingTarget,
  type Clip,
} from '../video/clips';
import {
  MAX_CLIP_MS,
  budgetForRecording,
  endedBecause,
  type RecordingEnd,
} from '../video/storage';
import { nominalErrorMs, type TimeScale } from '../video/timing';
import { logEvent } from '../diag/crashlog';
import {
  CAUTION,
  DESTRUCTIVE,
  FAINT,
  GROUND,
  INK,
  INK_2,
  INK_BRIGHT,
  INTERACTIVE,
  INTERACTIVE_FILL,
  INTERACTIVE_ON_BG,
  LINE,
  LIVE,
  MUTED,
  SUNKEN,
  SURFACE_2,
} from '../theme';

/**
 * What a finished recording hands back.
 *
 * The two rates travel WITH the clip because layer 3 cannot run until the marking
 * screen has probed the frames, and by then this screen is gone. Passing them along
 * is what lets "the session claimed 240" appear in a refusal written minutes later.
 */
export type Recorded = {
  clip: Clip;
  /** What the coach asked for. */
  requestedFps: number;
  /** What the session said it settled on, or null if it never said. */
  selectedFps: number | null;
  /**
   * Always RECORDED, and that is the fact rather than a formality.
   *
   * Everything else on this screen asks iOS a question; this one answers it. A clip
   * from the photo library can be slow motion, and one from Files cannot be checked
   * at all — 'unknown', which earns a caveat. A clip filmed here is neither: nobody
   * failed to ask whether its playback time is real time, because we set the rate
   * ourselves and verify it against the file afterwards. Carrying the value rather
   * than assuming it downstream is what stops this path drifting into the branch
   * that warns about slow motion on the route a coach takes forty times a session.
   */
  timeScale: TimeScale;
  /** A sentence when the recording ended by itself, null when a finger stopped it. */
  note: string | null;
};

/** How often the live readout re-reads the recorder. Every value on screen during a
 *  recording is read FROM it — none is counted up in JS. */
const TICK_MS = 200;

export function VideoRecordModal({
  visible,
  onCancel,
  onRecorded,
}: {
  visible: boolean;
  onCancel: () => void;
  onRecorded: (r: Recorded) => void;
}) {
  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('back');
  // enableAudio false: see the header. It also keeps the recording free of a track
  // nobody plays and bytes nobody wants.
  const videoOutput = useVideoOutput({ enableAudio: false });

  const [target, setTarget] = useState<number>(DEFAULT_FPS);
  /**
   * What the session reported, AND which target it reported for.
   *
   * The pair is the point. Changing the rate re-negotiates the session, and until it
   * reports again the previous answer is about a different configuration — so
   * switching 120 to 240 and pressing record immediately would validate the new
   * request against the old session's agreement. Storing the target alongside makes
   * a stale report indistinguishable from no report, which acceptSession already
   * refuses.
   */
  const [session, setSession] = useState<{ forFps: number; fps: number | null } | null>(null);
  const [recording, setRecording] = useState(false);
  /** Read from the recorder, never counted in JS. */
  const [live, setLive] = useState({ seconds: 0, bytes: 0 });

  const recorder = useRef<Recorder | null>(null);
  const clipId = useRef<string | null>(null);
  /** Set when the coach cancels mid-recording, so the finish callback throws the
   *  file away instead of handing back a rep nobody wants. */
  const abandoned = useRef(false);

  // Space, checked when the sheet opens so a refusal is visible BEFORE the athlete
  // is on the line — and checked again on the press, because the answer is only true
  // for an instant.
  const [space, setSpace] = useState(() => budgetForRecording(freeDiskBytes()));
  useEffect(() => {
    if (visible) setSpace(budgetForRecording(freeDiskBytes()));
  }, [visible]);

  /**
   * Whether the camera has ever been on screen, and why that is not just laziness.
   *
   * THE PREVIEW CAME BACK BLACK when the Modal became an always-mounted overlay. The
   * session recorded correctly — the footage was fine — but nothing was drawn, which
   * is the signature of a preview layer that was laid out while its container had no
   * size. `display: 'none'` gives a Yoga node zero dimensions, so <Camera> mounted
   * into a zero-rect view and AVCaptureVideoPreviewLayer kept that frame.
   *
   * So the camera is not mounted until the sheet is first OPENED — its very first
   * layout is a real, full-screen one — and after that it is never unmounted, which
   * is what the crash fix requires. Hiding is done with opacity rather than display,
   * so the layout stays valid on every later close and reopen.
   */
  const [everOpened, setEverOpened] = useState(false);
  useEffect(() => {
    if (visible) setEverOpened(true);
  }, [visible]);

  // A rate the session has not spoken about yet is not agreed to.
  const settledFps = session && session.forFps === target ? session.fps : null;

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => {
      const rec = recorder.current;
      if (!rec) return;
      try {
        setLive({ seconds: rec.recordedDuration, bytes: rec.recordedFileSize });
      } catch {
        // A recorder that has already finished throws rather than reporting zero.
        // The final numbers come off the FILE anyway, so there is nothing to do.
      }
    }, TICK_MS);
    return () => clearInterval(t);
  }, [recording]);

  const finish = useCallback(
    (reason: RecordingEnd) => {
      const id = clipId.current;
      clipId.current = null;
      recorder.current = null;
      setRecording(false);
      setLive({ seconds: 0, bytes: 0 });
      if (!id) return;

      if (abandoned.current) {
        abandoned.current = false;
        discardRecording(id);
        return;
      }

      const clip = claimRecording(id);
      if (!clip) {
        Alert.alert(
          'Nothing was recorded',
          'The camera finished but wrote no usable file. Nothing has been kept. If this ' +
            'repeats, close the app and open it again before running another rep.',
        );
        return;
      }
      onRecorded({
        clip,
        requestedFps: target,
        selectedFps: settledFps,
        timeScale: 'recorded',
        note: endedBecause(reason),
      });
    },
    [onRecorded, target, settledFps],
  );

  const start = useCallback(async () => {
    if (recording || !videoOutput || !device) return;

    // LAYER 1 AND LAYER 2, before the rep. Refused, not warned: a rate that was
    // negotiated away produces a plausible time that is wrong by the ratio, and the
    // only moment that costs nothing to catch is this one.
    const verdict = acceptSession(target, device.supportsFPS(target), settledFps);
    if (!verdict.ok) {
      Alert.alert('Not at that frame rate', verdict.reason);
      return;
    }

    // Re-read the disk. The figure shown when the sheet opened is not the figure now,
    // and a coach who deleted clips in another pane deserves the better answer.
    const now = budgetForRecording(freeDiskBytes());
    setSpace(now);
    if (!now.ok) {
      Alert.alert('Not enough room', now.reason);
      return;
    }

    const { id, path } = newRecordingTarget();
    clipId.current = id;
    abandoned.current = false;

    try {
      // BOTH BOUNDS ARE THE RECORDER'S, not ours. maxDuration is the safety rail and
      // maxFileSize is the budget cut from measured free space; either one ending the
      // recording still finalizes the file. Omitted rather than guessed when the
      // phone would not say how much space is free — see storage.ts on why that is a
      // warning here and a refusal in capture.ts.
      logEvent('CAMERA', `createRecorder at ${target}fps, session reported ${settledFps ?? 'nothing'}`);
      const rec = await videoOutput.createRecorder({
        filePath: path,
        maxDuration: MAX_CLIP_MS / 1000,
        ...(now.budgetBytes !== null ? { maxFileSize: now.budgetBytes } : {}),
      });
      recorder.current = rec;
      setRecording(true);
      setLive({ seconds: 0, bytes: 0 });
      await rec.startRecording(
        (_filePath, reason) => finish(reason as RecordingEnd),
        (err) => {
          clipId.current = null;
          recorder.current = null;
          setRecording(false);
          discardRecording(id);
          Alert.alert('The recording failed', err instanceof Error ? err.message : String(err));
        },
      );
    } catch (e) {
      clipId.current = null;
      recorder.current = null;
      setRecording(false);
      discardRecording(id);
      Alert.alert('Could not start recording', e instanceof Error ? e.message : String(e));
    }
  }, [recording, videoOutput, device, target, settledFps, finish]);

  /**
   * Stop a recording something else interrupted, and say what happened.
   *
   * A PHONE CALL IS THE ORDINARY CASE, not an edge one. iOS takes the camera for an
   * incoming call, Control Centre, or the app being backgrounded mid-rep, and none of
   * that was handled at all: the session went away, the recorder was left believing
   * it was running, and the coach got no explanation for a rep that did not save.
   *
   * The file written so far is KEPT. It is a real recording of a real rep, just a
   * short one, and deleting a coach's footage because the phone rang is the wrong
   * answer. This is the same reasoning as the duration and byte caps, which also stop
   * early and keep what they have.
   */
  const stopBecauseInterrupted = useCallback(
    async (what: string) => {
      const rec = recorder.current;
      logEvent('CAMERA', `interrupted: ${what}${rec ? ' (recording)' : ''}`);
      if (!rec) return;
      try {
        await rec.stopRecording();
      } catch {
        // Already stopping. The finish callback owns the outcome either way.
      }
      Alert.alert(
        'Recording stopped',
        `${what} interrupted the camera, so the recording was stopped. What was filmed up to ` +
          'that point is kept and can be marked.',
      );
    },
    [],
  );

  // BACKGROUNDING. The Camera's own interruption callbacks cover the session being
  // taken; this covers the app going away, which on iOS suspends JS before anything
  // else can react. Checked on every change rather than only on 'background',
  // because 'inactive' is what a call banner produces first.
  useEffect(() => {
    if (!recording) return;
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') void stopBecauseInterrupted('Leaving the app');
    });
    return () => sub.remove();
  }, [recording, stopBecauseInterrupted]);

  // A RECORDING MUST NOT OUTLIVE THIS SCREEN. Leaving the Video tab unmounts the
  // whole tree — App.tsx renders VideoTab conditionally — and without this the native
  // recorder would keep writing to a file whose id had just been forgotten, leaving
  // bytes on disk that nothing references and nothing can name.
  useEffect(() => {
    return () => {
      const rec = recorder.current;
      const id = clipId.current;
      if (!rec) return;
      logEvent('CAMERA', 'screen unmounted while recording — cancelling');
      rec.cancelRecording().catch(() => {});
      if (id) discardRecording(id);
    };
  }, []);

  const stop = useCallback(async () => {
    const rec = recorder.current;
    if (!rec) return;
    try {
      await rec.stopRecording();
    } catch (e) {
      // Already stopped — the cap beat the finger to it. The finish callback has
      // fired or is about to, and it owns the outcome either way.
      void e;
    }
  }, []);

  /** Leave. A recording in flight is thrown away rather than silently kept: the
   *  coach pressed Cancel, and a rep they abandoned is not a rep. */
  const leave = useCallback(async () => {
    const rec = recorder.current;
    if (rec) {
      abandoned.current = true;
      try {
        await rec.cancelRecording();
      } catch {
        const id = clipId.current;
        if (id) discardRecording(id);
      }
    }
    onCancel();
  }, [onCancel]);

  const remaining = Math.max(0, MAX_CLIP_MS / 1000 - live.seconds);

  // NOT A <Modal>, AND THAT IS THE CRASH FIX.
  //
  // Three crash reports, two of them identical, and the backtrace names the cause
  // exactly once you read it bottom-up:
  //
  //     hermes::vm::HadesGC::Executor::worker()          <- the JS garbage collector,
  //     hermes::vm::HadesGC::incrementalCollect             on its own background
  //     hermes::vm::HadesGC::OldGen::sweepNext              thread, named "hades"
  //     facebook::hermes::deleteShared(... NativeState*)
  //     margelo::nitro::camera::HybridCameraSessionSpecSwift::~...
  //     HybridCameraSession.deinit
  //     -[AVCaptureSession dealloc]
  //     -[AVCaptureSession _makeConfigurationLive:]
  //     -[AVCaptureOutput detachFromFigCaptureSession:]
  //     __assert_rtn  ->  abort()                        <- AVFoundation refuses
  //
  // The camera session was collected as JS GARBAGE and therefore deallocated on
  // Hermes's background GC thread, where AVFoundation's own teardown assertion
  // fails. React Native's Modal returns null from render() whenever it is hidden, so
  // EVERY close of this sheet unmounted <Camera> and left a live capture session for
  // the collector to find. The crash then lands whenever GC next runs — which is why
  // it read as random, and why it clustered during rapid record/mark/keep cycles and
  // rate switching: those are what produce the garbage.
  //
  // An always-mounted overlay keeps the session object referenced for as long as this
  // screen lives, so it is never collected while in use. isActive still stops the
  // hardware; what changed is that the OBJECT stays alive.
  //
  // RESIDUAL, stated rather than hidden: leaving the Video tab unmounts VideoTab (see
  // App.tsx) and drops the session for real. That is once per tab-leave instead of
  // once per rep, and it is a VisionCamera/Nitro teardown-thread bug underneath —
  // fixing it properly needs the session torn down on the main thread before its last
  // reference goes, which this API does not expose.
  //
  // Android's hardware back no longer closes the sheet, since that was the Modal's
  // onRequestClose. iOS-first, and Cancel is on screen.
  return (
    <View
      style={[styles.overlay, !visible && styles.offscreen]}
      pointerEvents={visible ? 'auto' : 'none'}
    >
      <View style={styles.root}>
        <View style={styles.preview}>
          {!hasPermission ? (
            <View style={styles.centre}>
              <Text style={styles.placeholder}>
                EqualSplit needs the camera to film a rep. Nothing is uploaded and the microphone
                is never used.
              </Text>
              <Pressable
                onPress={async () => {
                  // A HARD DENIAL CANNOT BE UNDONE BY ASKING AGAIN. Once the coach has
                  // refused once, requestPermission resolves false without showing
                  // anything, so a button that only calls it is a dead end that looks
                  // like a broken button. Settings is the only route back.
                  const granted = await requestPermission();
                  if (!granted) {
                    Alert.alert(
                      'Camera access is off',
                      'iOS will not ask again once access has been refused. Turn the camera on ' +
                        'for EqualSplit in Settings, then come back.',
                      [
                        { text: 'Not now', style: 'cancel' },
                        { text: 'Open Settings', onPress: () => void Linking.openSettings() },
                      ],
                    );
                  }
                }}
                style={styles.grant}
              >
                <Text style={styles.grantText}>Allow camera</Text>
              </Pressable>
            </View>
          ) : !device ? (
            <View style={styles.centre}>
              <Text style={styles.placeholder}>No back camera on this device.</Text>
            </View>
          ) : !everOpened ? null : (
            <Camera
              style={StyleSheet.absoluteFill}
              device={device}
              outputs={[videoOutput]}
              // Only while the sheet is up. An active session holds the camera, keeps
              // the phone warm and shortens how long 240fps can be held later.
              isActive={visible}
              constraints={[{ fps: target }]}
              onSessionConfigSelected={(c: CameraSessionConfig) => {
                logEvent('CAMERA', `session selected ${c.selectedFPS ?? 'undefined'}fps for a requested ${target}`);
                setSession({ forFps: target, fps: c.selectedFPS ?? null });
              }}
              // ITS DEFAULT IS console.error, which on a phone nobody has attached
              // to Xcode is silence. A session error is often the last thing the app
              // manages to say before a native crash takes the process — so it is
              // the one line most worth having, and it was going nowhere.
              onError={(e: Error) => logEvent('CAMERA', `session error: ${e.message}`)}
              onConfigured={() => logEvent('CAMERA', 'session configured')}
              onStarted={() => logEvent('CAMERA', 'session started')}
              onStopped={() => logEvent('CAMERA', 'session stopped')}
              // The callbacks that were flagged as existing and unused. A phone call
              // is the ordinary case, and it produces one of these.
              onInterruptionStarted={(reason: string) => void stopBecauseInterrupted(`Something else (${reason})`)}
              onInterruptionEnded={() => logEvent('CAMERA', 'interruption ended')}
            />
          )}

          {recording ? (
            <View style={styles.hud}>
              <View style={styles.dot} />
              {/* Every number here is READ FROM THE RECORDER, not counted up in JS.
                  A JS timer and the encoder disagree the moment the phone is busy,
                  and the one that decides when the cap fires is the encoder's. */}
              <Text style={styles.hudText}>
                {live.seconds.toFixed(1)}s · {formatBytes(live.bytes)}
              </Text>
              <Text style={styles.hudSub}>{remaining.toFixed(0)}s left</Text>
            </View>
          ) : null}
        </View>

        <View style={styles.controls}>
          {/* The rate, with what it BUYS beside it. A coach choosing between 120 and
              240 is choosing frame length, and the number that decides it is ±ms —
              not the label. These are WHOLE FRAMES now rather than a statistical
              spread, so they read larger than they used to and are the figures the
              method can actually defend. The body-part bias is still the term you
              cannot remove, and it dwarfs all four. */}
          <View style={styles.rates}>
            {CAPTURE_RATES.map((f) => (
              <Pressable
                key={f}
                style={[styles.rate, target === f && styles.rateOn]}
                onPress={() => setTarget(f)}
                disabled={recording}
                accessibilityRole="button"
                accessibilityState={{ selected: target === f }}
              >
                <Text style={[styles.rateText, target === f && styles.rateTextOn]}>{f}</Text>
                <Text style={[styles.rateSub, target === f && styles.rateSubOn]}>
                  ±{nominalErrorMs(1 / f).toFixed(1)}ms
                </Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.note}>
            {settledFps === null
              ? 'Waiting for the camera to say what it settled on.'
              : Math.abs(settledFps - target) < 1
                ? `Camera settled on ${Math.round(settledFps)}fps. The file is checked again after ` +
                  'the recording, and it is the file that decides.'
                : `The camera settled on ${Math.round(settledFps)}fps, not ${target}. Recording is ` +
                  'refused at this rate.'}
          </Text>

          {/* Space, said before the rep rather than after it. A refusal disables the
              button; a warning does not, because the duration cap still bounds it. */}
          {!space.ok ? (
            <Text style={styles.refusal}>{space.reason}</Text>
          ) : space.warn ? (
            <Text style={styles.warn}>{space.warn}</Text>
          ) : null}

          <View style={styles.row}>
            <Pressable style={styles.secondary} onPress={() => void leave()}>
              <Text style={[styles.secondaryText, recording && styles.discardText]}>
                {recording ? 'Discard' : 'Cancel'}
              </Text>
            </Pressable>
            {/* ONE COLOUR FOR BOTH LABELS. The first draft made Stop red, which is
                what a camera app does and what this app's palette forbids: red means
                "this destroys something", and stopping a recording destroys nothing —
                it is how you KEEP the rep. Discard beside it is the destructive act
                and is the only thing here wearing that colour. What is live is said
                by the dot on the preview, which is the one form LIVE may take. */}
            <Pressable
              style={[styles.primary, !space.ok && !recording && styles.disabled]}
              onPress={() => void (recording ? stop() : start())}
              disabled={!space.ok && !recording}
            >
              <Text style={styles.primaryText}>{recording ? 'Stop' : 'Record'}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Absolute rather than a Modal, so the camera session is never garbage. See the
  // note at the render. zIndex keeps it over the marking screen it covers.
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 10 },
  // OPACITY, NOT display: 'none'. A hidden Yoga node has zero size, and a camera
  // preview laid out at zero keeps that frame — which is what turned the preview
  // black. Opacity leaves the layout real, so the layer is always correctly sized.
  // pointerEvents on the container is what stops an invisible sheet eating taps.
  offscreen: { opacity: 0 },
  root: { flex: 1, backgroundColor: GROUND },
  // Black, not SUNKEN: this is the area a camera image fills, and any tint behind
  // it shows at the letterbox edges as a colour cast on the footage.
  preview: { flex: 1, backgroundColor: '#000', justifyContent: 'center' },
  centre: { alignItems: 'center', gap: 14, paddingHorizontal: 28 },
  placeholder: { color: MUTED, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  grant: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: INTERACTIVE_FILL,
  },
  grantText: { color: INK_BRIGHT, fontSize: 15, fontWeight: '700' },

  hud: {
    position: 'absolute',
    top: 58,
    left: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#000a',
  },
  // A filled indicator dot, which is the only form LIVE is allowed to take — see
  // theme.ts on why green and orange are separated by SHAPE here rather than by hue.
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: LIVE },
  hudText: { color: INK_BRIGHT, fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
  hudSub: { color: MUTED, fontSize: 12.5, fontVariant: ['tabular-nums'] },

  controls: { padding: 12, paddingBottom: 30, gap: 10 },
  rates: { flexDirection: 'row', gap: 6 },
  rate: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
    borderRadius: 9,
    backgroundColor: SURFACE_2,
    borderWidth: 1,
    borderColor: LINE,
  },
  rateOn: { backgroundColor: INTERACTIVE_ON_BG, borderColor: INTERACTIVE },
  rateText: { color: INK, fontSize: 16, fontWeight: '800' },
  rateTextOn: { color: INK_BRIGHT },
  rateSub: { color: FAINT, fontSize: 11, fontVariant: ['tabular-nums'] },
  rateSubOn: { color: INTERACTIVE },

  note: { color: MUTED, fontSize: 12, lineHeight: 17 },
  warn: { color: CAUTION, fontSize: 12, lineHeight: 17 },
  refusal: { color: DESTRUCTIVE, fontSize: 12, lineHeight: 17 },

  row: { flexDirection: 'row', gap: 10, marginTop: 2 },
  secondary: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: LINE,
    backgroundColor: SUNKEN,
  },
  secondaryText: { color: INK_2, fontSize: 15, fontWeight: '700' },
  discardText: { color: DESTRUCTIVE },
  primary: {
    flex: 2,
    alignItems: 'center',
    paddingVertical: 14,
    borderRadius: 10,
    backgroundColor: INTERACTIVE_FILL,
  },
  primaryText: { color: INK_BRIGHT, fontSize: 15, fontWeight: '800' },
  disabled: { opacity: 0.45 },
});
