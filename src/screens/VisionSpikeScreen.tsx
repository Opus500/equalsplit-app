// SPIKE — NOT PRODUCT CODE. Delete with the branch.
//
// VisionCamera compatibility spike. Go/no-go on in-app recording before any
// recording UI exists. Answers:
//
//   1. Does it build on RN 0.85.3 / React 19.2.3 / SDK 56 with the New
//      Architecture?  -> the build either succeeds or it doesn't; this screen
//      only has to RUN for that to be answered.
//   2. Does the device report 240fps support, and does constraining to it
//      actually take effect?
//   4. Does a clip recorded in-app seek and report actualTime under expo-video
//      the same way an imported one does?
//
// (3, the version choice, was settled from the packages: see the commit message.)
//
// ---------------------------------------------------------------------------
// SECOND PASS. Test 4 failed with "Cannot Decode", and it was this harness, not
// the camera. Two defects in one call, both already found and fixed in the app
// eighteen hours AFTER this file was written:
//
//   n > 1   expo-video's generateThumbnailsAsync fails with AVErrorDecodeFailed
//           for any array longer than one. Its AVAssetImageGenerator is a local
//           whose last use is the images(for:) call, so ARC releases it while the
//           async sequence is still being consumed and the generator cancels
//           pending work on dealloc. This asked for 120 at once.
//
//   maxW    getMaxSize() builds CGSize(maxWidth, maxHeight) with each defaulting
//           to 0, so passing maxWidth alone yields a zero dimension. Independently
//           capable of failing, which is why fixing only the batch might not have
//           cleared it.
//
// It also carried the belief that produced the first defect — the older timing
// spike closes with "Batching matters: one generator, one decode session". It does
// not. Five calls made CONCURRENTLY all succeed, which is what ruled out resource
// contention and gave the fan-out below.
//
// The three measurements added with the fix are the ones that decide Stage 3, and
// none of them is a camera question:
//
//   1. BYTES     what a 240fps clip costs per minute. The video library exists
//                because clips are large, and it was sized against 30fps.
//   2. PROBE     what the marking screen's OWN probe pattern costs on this file.
//                18 extractions, 1 serial anchor + 17 fanned 8 at a time — the
//                exact shape probeGridAround uses. ~154ms at 30fps is the bar.
//   3. HOLD      whether 240 survives a 60-second recording, measured in three
//                windows of the file rather than asked of the session.
//
// Only the file is evidence. That was true of the fps constraint and it is true of
// all three of these.
//
// The proof for 2 is deliberately three-layered, because a camera that silently
// ignores a constraint is the exact failure mode worth catching:
//   - what the DEVICE claims       (supportsFPS / supportedFPSRanges)
//   - what the SESSION resolved to (onSessionConfigSelected -> selectedFPS)
//   - what the FILE actually contains (frame timestamps measured afterwards)
// Only the third is real evidence. The first two can both be right while the
// recorded file is 30fps.

import { useCallback, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useVideoOutput,
  type CameraSessionConfig,
  type Recorder,
} from 'react-native-vision-camera';
import { useVideoPlayer, type VideoPlayer } from 'expo-video';
import { File } from 'expo-file-system';

const TARGETS = [30, 60, 120, 240];
const RECORD_MS = 3000;
/** Long enough for thermal throttling to show up, short enough to sit through. */
const LONG_RECORD_MS = 60_000;

// ---- the app's probe shape, replicated rather than imported --------------
//
// This branch predates src/video/frames.ts, and merging the feature branch into a
// spike to borrow four constants would make the spike something else. They are
// copied with their sources named, and the numbers are the point: a measurement of
// a DIFFERENT probe pattern would answer a question nobody asked.

/** src/video/timing.ts FRAME_FAN_OUT — concurrent extractions in flight. */
const FAN_OUT = 8;
/** src/video/frames.ts PROBE_SIZE — grid probes discard the image. */
const PROBE_SIZE = 64;
/** src/video/frames.ts probeGridAround framesEitherSide. 1 anchor + 17 = 18 calls. */
const PROBE_HALF = 8;
/** What that costs on a 30fps H.264 clip today, measured on device. The bar. */
const REF_30FPS_MS = 154;

// ---------------------------------------------------------------- helpers

/**
 * ONE frame. The fixed call.
 *
 * One time per request, never an array — and BOTH dimensions, or getMaxSize()
 * hands AVFoundation a zero-height CGSize. Returns null instead of throwing so a
 * probe that loses its last frame still reports the rest.
 */
async function oneFrame(player: VideoPlayer, time: number): Promise<number | null> {
  try {
    const [thumb] = await player.generateThumbnailsAsync([time], {
      maxWidth: PROBE_SIZE,
      maxHeight: PROBE_SIZE,
    });
    return thumb ? thumb.actualTime : null;
  } catch {
    return null;
  }
}

/** At most FAN_OUT in flight, matching the app. Concurrency is what makes n=1 fast
 *  enough to be usable; serial calls would measure a pattern the app never runs. */
async function fanOut(jobs: (() => Promise<number | null>)[]): Promise<(number | null)[]> {
  const out: (number | null)[] = [];
  for (let i = 0; i < jobs.length; i += FAN_OUT) {
    out.push(...(await Promise.all(jobs.slice(i, i + FAN_OUT).map((j) => j()))));
  }
  return out;
}

/**
 * probeGridAround's exact shape, timed: one SERIAL anchor to learn the grid phase,
 * then 17 aligned probes fanned out.
 *
 * The anchor is serial on purpose and it is a third of the cost — without a real
 * timestamp to anchor to you cannot aim at frame centres, and the alternative is
 * oversampling at quarter-frame granularity.
 */
async function probeOnce(
  player: VideoPlayer,
  centre: number,
  frameDur: number,
): Promise<{ ms: number; calls: number; frames: number[] }> {
  const t0 = Date.now();
  const anchor = await oneFrame(player, centre);
  if (anchor === null) return { ms: Date.now() - t0, calls: 1, frames: [] };

  const times: number[] = [];
  for (let k = -PROBE_HALF; k <= PROBE_HALF; k += 1) {
    const t = anchor + (k + 0.5) * frameDur;
    if (t > 0) times.push(t);
  }
  const got = await fanOut(times.map((t) => () => oneFrame(player, t)));
  const frames = [...new Set([anchor, ...got.filter((x): x is number => x !== null)])].sort(
    (a, b) => a - b,
  );
  return { ms: Date.now() - t0, calls: 1 + times.length, frames };
}

/**
 * Median gap between neighbouring frames, in seconds. Null below two gaps.
 *
 * MEDIAN, not mean: robust to a dropped frame, which is the thing being looked for.
 * And computed only WITHIN one probeOnce result, never across two — separate probes
 * are separate islands with unprobed clip between them, and measuring across that
 * gap is the bug that read 0.67fps on a constant 30fps clip.
 */
function medianGap(frames: number[]): number | null {
  if (frames.length < 3) return null;
  const d: number[] = [];
  for (let i = 1; i < frames.length; i += 1) d.push(frames[i]! - frames[i - 1]!);
  d.sort((a, b) => a - b);
  const mid = Math.floor(d.length / 2);
  const m = d.length % 2 ? d[mid]! : (d[mid - 1]! + d[mid]!) / 2;
  return m > 0 ? m : null;
}

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

export default function VisionSpikeScreen() {
  const [log, setLog] = useState<string[]>([
    'VisionCamera spike. Grant camera access, pick an fps, record, then Measure.',
    'Rec 3s answers bytes and probe cost. Rec 60s answers whether the rate holds.',
    '',
  ]);
  const [target, setTarget] = useState(240);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);

  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('back');
  // No audio: it would pull in a microphone permission the spike never uses.
  const videoOutput = useVideoOutput({ enableAudio: false });

  const selectedFps = useRef<number | undefined>(undefined);
  const clipPath = useRef<string | null>(null);
  /** Bytes of the last recording. The RATE needs the measured duration, which only
   *  the player knows, so the two halves meet in measure(). */
  const clipBytes = useRef(0);
  const recorder = useRef<Recorder | null>(null);

  // A second player, only to interrogate the recorded file. Loading it here
  // rather than in the video spike keeps that branch untouched.
  const player = useVideoPlayer(null, (p) => {
    p.muted = true;
    p.pause();
  });

  const say = useCallback((...lines: string[]) => setLog((prev) => [...prev, ...lines]), []);

  // ------------------------------------------------------ 1 + 2: device

  const inspect = useCallback(() => {
    if (!device) {
      say('No back camera device. If this persists the session never opened.', '');
      return;
    }
    const ranges = device.supportedFPSRanges
      .map((r) => `${r.min}-${r.max}`)
      .join(', ');
    say(
      '=== DEVICE ===',
      `id            ${device.id}`,
      `name          ${device.name}`,
      `position      ${device.position}`,
      `fps ranges    ${ranges}`,
      ...TARGETS.map((f) => `supportsFPS(${String(f).padStart(3)})  ${device.supportsFPS(f) ? 'YES' : 'no'}`),
      '',
      'NOTE: a device may report a range it cannot hold once outputs and',
      'stabilization are negotiated. selectedFPS below is the resolved answer.',
      '',
    );
  }, [device, say]);

  const onConfig = useCallback(
    (config: CameraSessionConfig) => {
      selectedFps.current = config.selectedFPS;
      say(
        `=== SESSION RESOLVED (asked for ${target}) ===`,
        `selectedFPS   ${config.selectedFPS ?? 'undefined'}`,
        `binned        ${config.isBinned}`,
        config.selectedFPS === target
          ? '  constraint HELD'
          : `  !! negotiated DOWN to ${config.selectedFPS ?? '?'} — the constraint did not hold`,
        '',
      );
    },
    [target, say],
  );

  // ------------------------------------------------------- record

  const record = useCallback(async (ms: number) => {
    if (busy || !videoOutput) return;
    setBusy(true);
    setRecording(true);
    try {
      clipPath.current = null;
      const rec = await videoOutput.createRecorder({});
      recorder.current = rec;

      const finished = new Promise<string>((resolve, reject) => {
        rec.startRecording(
          (filePath, reason) => {
            say(`  recording finished (${reason})`, `  ${filePath}`);
            resolve(filePath);
          },
          (err) => reject(err),
        ).catch(reject);
      });

      say('=== RECORDING ===', `  ${(ms / 1000).toFixed(0)}s at a requested ${target}fps`);
      await new Promise((r) => setTimeout(r, ms));
      await rec.stopRecording();

      const path = await finished;
      clipPath.current = path;

      // ---- MEASUREMENT 1: what does this cost to keep? -------------------
      //
      // Read off the file rather than estimated from a bitrate. The video library
      // exists because clips are large, and its sizing was done against 30fps
      // footage — this is the number that says whether that still holds.
      const uri = path.startsWith('file://') ? path : `file://${path}`;
      let bytes = 0;
      try {
        bytes = new File(uri).size ?? 0;
      } catch {
        bytes = 0;
      }
      clipBytes.current = bytes;
      say(
        '',
        '=== 1. BYTES ===',
        `  requested     ${(ms / 1000).toFixed(0)}s at ${target}fps`,
        `  file size     ${bytes} bytes  (${mb(bytes)} MB)`,
        bytes > 0 ? '' : '  !! size unreadable — the path may not be a plain file',
        // The RATE is computed in MEASURE, against player.duration. Dividing by the
        // requested milliseconds understated it by 5%: a "3s" recording came back
        // 2.8583s long, and the rate is bytes per second of FOOTAGE, not per second
        // of intent. Cross-checked — correcting the 3s run at 240 gives 262 MB/min
        // and the 60s run measured 259.8.
        '  rate reported in MEASURE, against the real duration of the file',
        '',
        'Now run MEASURE — the file is the only evidence that counts.',
        '',
      );
    } catch (e) {
      say(`!! ${e instanceof Error ? e.message : String(e)}`, '');
    } finally {
      setRecording(false);
      setBusy(false);
    }
  }, [busy, videoOutput, target, say]);

  // ------------------------------------- 2 + 3: probe cost, and does 240 hold

  const measure = useCallback(async () => {
    if (busy) return;
    const path = clipPath.current;
    if (!path) {
      say('Record a clip first.', '');
      return;
    }
    setBusy(true);
    try {
      const uri = path.startsWith('file://') ? path : `file://${path}`;
      await player.replaceAsync(uri);
      await new Promise((r) => setTimeout(r, 500));

      const track = player.videoTrack ?? player.availableVideoTracks[0] ?? null;
      const nominal = track?.frameRate && track.frameRate > 0 ? track.frameRate : target;
      const dur = player.duration;
      say(
        '=== THE FILE ===',
        `  duration      ${dur.toFixed(4)}s`,
        `  size          ${track?.size ? `${track.size.width}x${track.size.height}` : '?'}`,
        `  codec         ${track?.mimeType ?? '?'}`,
        `  nominal fps   ${nominal}`,
        '',
      );

      // A seed only. nominalFrameRate is an average, and the real spacing comes
      // back from the grid — a clip reporting 239.467 is not telling you its frames
      // are 4.176ms apart, it is telling you it averaged that.
      const frameDur = 1 / nominal;

      // ---- MEASUREMENT 1 completed: rate, against the REAL duration ---------
      const bytes = clipBytes.current;
      if (bytes > 0) {
        const perMin = (bytes / dur) * 60;
        say(
          '=== 1. BYTES ===',
          `  file          ${mb(bytes)} MB over ${dur.toFixed(4)}s of footage`,
          `  rate          ${mb(perMin)} MB per minute`,
          `  40 reps x 5s  ${(perMin * (200 / 60) / 1024 / 1024 / 1024).toFixed(2)} GB per session`,
          `  20 min solid  ${(perMin * 20 / 1024 / 1024 / 1024).toFixed(2)} GB  (the case a length cap prevents)`,
          '',
        );
      }

      // ---- MEASUREMENT 2: cost ACROSS the clip, not a median of three -------
      //
      // The median was the wrong tool here and it hid the finding. Median-of-three
      // is right for the RATE, where position is noise; for COST it is not, because
      // position is a variable. On a 2.86s clip at 120fps the cost climbed 387 ->
      // 517 -> 685ms start to end, and the FINISH mark — the one that decides the
      // time — lives at the expensive end.
      //
      // The open question a median cannot answer: does cost grow linearly with
      // distance from a single keyframe at the head of the file, or reset
      // periodically at later keyframes? Linear means a 15s clip ends near 2.2s per
      // probe and the length cap has to be short. Sawtooth means it is bounded and
      // the cap is a storage decision only. Eight samples can tell those apart;
      // three cannot.
      const SAMPLES = 8;
      const rows: string[] = [];
      const rates: number[] = [];
      const costs: number[] = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        const at = dur * ((i + 0.5) / SAMPLES);
        const r = await probeOnce(player, at, frameDur);
        const gap = medianGap(r.frames);
        const fps = gap ? 1 / gap : null;
        if (fps) rates.push(fps);
        costs.push(r.ms);
        rows.push(
          `  ${at.toFixed(2)}s  frame ${String(Math.round(at * nominal)).padStart(5)}  ` +
            `${String(r.ms).padStart(5)}ms  ${String(r.frames.length).padStart(2)} fr  ` +
            (fps ? `${fps.toFixed(1)} fps` : '—'),
        );
      }

      // A RESET is a sample materially cheaper than the one before it. With one
      // keyframe at the head there are none and the line only climbs.
      let resets = 0;
      for (let i = 1; i < costs.length; i += 1) if (costs[i]! < costs[i - 1]! * 0.75) resets += 1;
      const first = costs[0]!;
      const last = costs[costs.length - 1]!;
      const peak = Math.max(...costs);

      say(
        '=== 2. PROBE COST ACROSS THE CLIP — 18 calls each ===',
        ...rows,
        '',
        `  first sample  ${first}ms`,
        `  last sample   ${last}ms`,
        `  peak          ${peak}ms`,
        `  climb         ${(last / first).toFixed(2)}x end over start`,
        `  resets        ${resets}  ${resets === 0 ? '(none — one keyframe, cost grows with the clip)' : '(keyframes bound it)'}`,
        '',
        '  THE NUMBER THAT MATTERS is the PEAK, not the median. A finish mark sits',
        '  near the end of the clip by definition, so that is what the coach pays',
        '  on every settle.',
        '',
        resets === 0
          ? '  NO RESETS: cost is unbounded in clip length. The length cap is a'
          : '  RESETS FOUND: cost is bounded. The length cap is a storage decision',
        resets === 0
          ? '  PERFORMANCE decision as well as a storage one — measure 15s before'
          : '  only, and can be set on storage grounds alone.',
        resets === 0 ? '  setting it.' : '',
        '',
        `  same-device 30fps control: 359ms. Peak here is ${(peak / 359).toFixed(2)}x that.`,
        '  (The 154ms figure is an IMPORTED H.264 clip and is the wrong baseline for',
        '  a recorded HEVC one — about half that gap is the file, not the frame rate.)',
        '',
      );

      const spread = rates.length > 1 ? Math.max(...rates) - Math.min(...rates) : 0;
      const held = rates.length > 0 && rates.every((f) => Math.abs(f - target) < target * 0.1);
      say(
        `=== 3. DOES ${target} HOLD FOR ${dur.toFixed(0)}s? ===`,
        ...rates.map((f, i) => `  sample ${i + 1}  ${f.toFixed(2)} fps`),
        `  spread        ${spread.toFixed(2)} fps across the file`,
        held
          ? `  VERDICT: held. Every window is within 10% of ${target}.`
          : `  VERDICT: DID NOT HOLD — the file drifts off ${target}.`,
        rates.length > 1 && rates[rates.length - 1]! < rates[0]! * 0.9
          ? '  The END is slower than the START, which is what thermal throttling'
          : '',
        rates.length > 1 && rates[rates.length - 1]! < rates[0]! * 0.9
          ? '  looks like from the file. Run it again on a cold phone to confirm.'
          : '',
        '',
        '  Only the file counts. selectedFPS said what the session intended; this',
        '  says what it delivered, sixty seconds in.',
        '',
      );

      // Frame-accurate seeking still has to work on this file — the whole marking
      // screen rests on currentTime landing where it is told.
      if (rates.length) {
        const r = await probeOnce(player, dur * 0.1, frameDur);
        if (r.frames.length > 5) {
          const f = r.frames[3]!;
          player.currentTime = f + (r.frames[4]! - f) * 0.4;
          await new Promise((res) => setTimeout(res, 300));
          say(`  seek readback drift ${((player.currentTime - f) * 1000).toFixed(3)}ms from the frame PTS`, '');
        }
      }
    } catch (e) {
      say(`!! ${e instanceof Error ? e.message : String(e)}`, '');
    } finally {
      setBusy(false);
    }
  }, [busy, player, target, say]);

  // ------------------------------------------------------------- render

  if (!hasPermission) {
    return (
      <View style={styles.root}>
        <Text style={styles.placeholder}>Camera permission needed.</Text>
        <Pressable style={styles.btn} onPress={requestPermission}>
          <Text style={styles.btnText}>Grant</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.preview}>
        {device ? (
          <Camera
            style={StyleSheet.absoluteFill}
            device={device}
            outputs={[videoOutput]}
            isActive
            constraints={[{ fps: target }]}
            onSessionConfigSelected={onConfig}
          />
        ) : (
          <Text style={styles.placeholder}>no device</Text>
        )}
        {recording && <View style={styles.recDot} />}
      </View>

      <View style={styles.row}>
        {TARGETS.map((f) => (
          <Pressable
            key={f}
            style={[styles.btn, target === f && styles.btnOn]}
            onPress={() => setTarget(f)}
            disabled={busy}
          >
            <Text style={styles.btnText}>{f}</Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.row}>
        <Btn label="Device" onPress={inspect} off={busy} />
        <Btn label={`Rec ${RECORD_MS / 1000}s`} onPress={() => void record(RECORD_MS)} off={busy} />
        {/* Sixty seconds, because three proves nothing about thermal throttling. */}
        <Btn label={`Rec ${LONG_RECORD_MS / 1000}s`} onPress={() => void record(LONG_RECORD_MS)} off={busy} />
        <Btn label="Measure" onPress={() => void measure()} off={busy} />
      </View>

      <ScrollView style={styles.logBox} contentContainerStyle={styles.logPad}>
        <Text style={styles.log} selectable>
          {log.join('\n')}
        </Text>
      </ScrollView>
    </View>
  );
}

function Btn({ label, onPress, off }: { label: string; onPress: () => void; off: boolean }) {
  return (
    <Pressable style={[styles.btn, off && styles.btnOff]} onPress={onPress} disabled={off}>
      <Text style={styles.btnText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0e1116', paddingTop: 56, paddingHorizontal: 10 },
  preview: { height: 210, backgroundColor: '#000', borderRadius: 8, overflow: 'hidden', justifyContent: 'center', alignItems: 'center' },
  placeholder: { color: '#475569', fontSize: 13, textAlign: 'center', marginBottom: 12 },
  recDot: { position: 'absolute', top: 10, right: 10, width: 12, height: 12, borderRadius: 6, backgroundColor: '#ef4444' },
  row: { flexDirection: 'row', gap: 6, marginTop: 8 },
  btn: { flex: 1, backgroundColor: '#1e293b', borderRadius: 6, paddingVertical: 11, alignItems: 'center' },
  btnOn: { backgroundColor: '#1d4ed8' },
  btnOff: { opacity: 0.4 },
  btnText: { color: '#e2e8f0', fontSize: 13, fontWeight: '600' },
  logBox: { flex: 1, marginTop: 10, backgroundColor: '#0b0e13', borderRadius: 8 },
  logPad: { padding: 10 },
  log: { color: '#cbd5e1', fontSize: 10, fontFamily: 'Menlo', lineHeight: 14 },
});
