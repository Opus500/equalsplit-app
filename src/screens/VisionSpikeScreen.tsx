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
import { useVideoPlayer } from 'expo-video';

const TARGETS = [30, 60, 120, 240];
const RECORD_MS = 3000;

export default function VisionSpikeScreen() {
  const [log, setLog] = useState<string[]>(['VisionCamera spike. Grant camera access, then pick an fps.', '']);
  const [target, setTarget] = useState(240);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);

  const { hasPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('back');
  // No audio: it would pull in a microphone permission the spike never uses.
  const videoOutput = useVideoOutput({ enableAudio: false });

  const selectedFps = useRef<number | undefined>(undefined);
  const clipPath = useRef<string | null>(null);
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

  const record = useCallback(async () => {
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

      say('=== RECORDING ===', `  ${RECORD_MS}ms at a requested ${target}fps`);
      await new Promise((r) => setTimeout(r, RECORD_MS));
      await rec.stopRecording();

      clipPath.current = await finished;
      say('', 'Now run VERIFY — the file is the only evidence that counts.', '');
    } catch (e) {
      say(`!! ${e instanceof Error ? e.message : String(e)}`, '');
    } finally {
      setRecording(false);
      setBusy(false);
    }
  }, [busy, videoOutput, target, say]);

  // --------------------------------------------- 4: verify under expo-video

  const verify = useCallback(async () => {
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
      const nominal = track?.frameRate ?? target;
      say(
        '=== 4. THE RECORDED FILE, UNDER expo-video ===',
        `duration      ${player.duration.toFixed(4)}s`,
        `size          ${track?.size ? `${track.size.width}x${track.size.height}` : '?'}`,
        `codec         ${track?.mimeType ?? '?'}`,
        `nominal fps   ${nominal}`,
      );

      // Same probe as the video spike: distinct actualTimes ARE the frame grid.
      // If actualTime comes back undefined or constant here but works on an
      // imported clip, that is the finding this test exists for.
      const step = 1 / nominal;
      const start = Math.min(0.5, player.duration / 3);
      const probes: number[] = [];
      for (let i = 0; i < 120; i += 1) probes.push(start + (i * step) / 4);

      const t0 = Date.now();
      const thumbs = await player.generateThumbnailsAsync(probes, { maxWidth: 64 });
      const elapsed = Date.now() - t0;

      const distinct: number[] = [];
      for (const t of thumbs) {
        if (!distinct.length || t.actualTime !== distinct[distinct.length - 1]) distinct.push(t.actualTime);
      }
      distinct.sort((a, b) => a - b);

      const deltas: number[] = [];
      for (let i = 1; i < distinct.length; i += 1) deltas.push(distinct[i]! - distinct[i - 1]!);
      const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
      const spread = Math.max(...deltas) - Math.min(...deltas);
      const measured = 1 / mean;

      // Frame-accurate seeking, on this file specifically.
      const f = distinct[3]!;
      player.currentTime = f + (distinct[4]! - f) * 0.4;
      await new Promise((r) => setTimeout(r, 300));
      const readback = player.currentTime;

      say(
        `  ${elapsed}ms for 120 thumbs (${(elapsed / 120).toFixed(1)}ms each)`,
        `  distinct frames  ${distinct.length}`,
        `  actualTime works ${distinct.length > 5 ? 'YES — same as an imported clip' : 'NO — only ' + distinct.length + ' distinct values'}`,
        `  mean delta       ${(mean * 1000).toFixed(3)}ms`,
        `  spread           ${(spread * 1000).toFixed(3)}ms  (${spread < 0.0005 ? 'CFR' : 'VARIABLE'})`,
        `  MEASURED FPS     ${measured.toFixed(2)}`,
        '',
        '  --- the three layers ---',
        `  device claims    supportsFPS(${target}) = ${device?.supportsFPS(target) ?? '?'}`,
        `  session resolved selectedFPS = ${selectedFps.current ?? 'undefined'}`,
        `  file contains    ${measured.toFixed(2)} fps`,
        Math.abs(measured - target) < target * 0.1
          ? `  VERDICT: the file really is ~${target}fps. Constraint held end to end.`
          : `  VERDICT: asked ${target}, got ${measured.toFixed(1)}. The constraint did NOT`,
        Math.abs(measured - target) < target * 0.1 ? '' : '  reach the file — this is the failure mode worth catching.',
        `  seek readback drift ${((readback - f) * 1000).toFixed(3)}ms from the frame PTS`,
        '',
      );
    } catch (e) {
      say(`!! ${e instanceof Error ? e.message : String(e)}`, '');
    } finally {
      setBusy(false);
    }
  }, [busy, player, target, device, say]);

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
        <Btn label={`Record ${RECORD_MS / 1000}s`} onPress={record} off={busy} />
        <Btn label="Verify file" onPress={verify} off={busy} />
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
