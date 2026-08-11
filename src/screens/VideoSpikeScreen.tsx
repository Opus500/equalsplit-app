// SPIKE — NOT PRODUCT CODE. Delete with the branch.
//
// Answers three questions about frame-accurate video timing on iOS, against a
// REAL iPhone clip (a generated file would be constant-frame-rate and would hide
// the trap this screen exists to find):
//
//   1. Does setting expo-video's `currentTime` land on the exact frame, or snap
//      to a keyframe?
//   2. Does it report the true time of the frame being displayed?
//   3. Does expo-video-thumbnails return an exact frame at an arbitrary time,
//      and does it tell you which frame it gave you?
//
// The oracle for "what frame is really there" is expo-video's own
// generateThumbnailsAsync: its native side sets requestedTimeToleranceBefore and
// ...After to .zero and returns AVAssetImageGenerator's `actualTime` — the true
// presentation timestamp of the frame handed back. Everything else is measured
// against that.

import { useCallback, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useVideoPlayer, VideoView, type VideoPlayer } from 'expo-video';
import * as ImagePicker from 'expo-image-picker';
import * as VideoThumbnails from 'expo-video-thumbnails';

// ---------------------------------------------------------------- helpers

const ms = (seconds: number) => `${(seconds * 1000).toFixed(3)}ms`;

// A seek completes asynchronously and there is no completion promise on the JS
// side, so settle by polling until the reported time stops moving. The player is
// paused throughout, so a stable reading means the seek finished.
async function settle(player: VideoPlayer, timeoutMs = 1500): Promise<number> {
  const started = Date.now();
  let last = NaN;
  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 40));
    const now = player.currentTime;
    if (now === last) return now;
    last = now;
  }
  return last;
}

// ---------------------------------------------------------------- screen

export default function VideoSpikeScreen() {
  const [log, setLog] = useState<string[]>(['Pick an iPhone clip to begin.', '']);
  const [uri, setUri] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The true frame grid, recovered by probing. Test 1 fills it; the rest use it.
  const grid = useRef<number[]>([]);

  const player = useVideoPlayer(null, (p) => {
    p.muted = true;
    p.pause();
  });

  const say = useCallback((...lines: string[]) => {
    setLog((prev) => [...prev, ...lines]);
  }, []);

  const guard = useCallback(
    (fn: () => Promise<void>) => async () => {
      if (busy) return;
      setBusy(true);
      try {
        await fn();
      } catch (e) {
        say(`!! ${e instanceof Error ? e.message : String(e)}`, '');
      } finally {
        setBusy(false);
      }
    },
    [busy, say],
  );

  // ------------------------------------------------------------- pick

  const pick = guard(async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      say('Photo library permission denied.', '');
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['videos'],
      allowsEditing: false,
      // Transcoding would re-encode to constant frame rate and destroy the very
      // property we are here to measure.
      videoExportPreset: ImagePicker.VideoExportPreset.Passthrough,
    });
    if (res.canceled || !res.assets[0]) return;

    const asset = res.assets[0];
    setUri(asset.uri);
    grid.current = [];
    await player.replaceAsync(asset.uri);
    await new Promise((r) => setTimeout(r, 400)); // let tracks load

    const track = player.videoTrack ?? player.availableVideoTracks[0] ?? null;
    setLog([
      '=== CLIP ===',
      `uri            ${asset.uri.slice(-44)}`,
      `picker duration ${asset.duration ?? '?'}ms`,
      `player duration ${player.duration.toFixed(4)}s`,
      `size           ${track?.size ? `${track.size.width}x${track.size.height}` : '?'}`,
      `nominal fps    ${track?.frameRate ?? '?'}`,
      `codec          ${track?.mimeType ?? '?'}`,
      '',
      'NOTE: nominal fps is AVAssetTrack.nominalFrameRate — an average.',
      'It is NOT a promise that frames are evenly spaced. Test 1 checks.',
      '',
    ]);
  });

  // ------------------------------------------------- 1. real frame grid

  const probeGrid = guard(async () => {
    const track = player.videoTrack ?? player.availableVideoTracks[0] ?? null;
    const fps = track?.frameRate ?? 30;
    const step = 1 / fps;

    // Probe 30 nominal frames' worth of timeline at quarter-frame granularity:
    // 120 requests regardless of fps, so a 240fps clip costs the same as 30fps.
    // Distinct actualTimes ARE the true frame grid, variable spacing included.
    const start = Math.min(1.0, Math.max(0, player.duration / 3));
    const probes: number[] = [];
    for (let i = 0; i < 120; i += 1) probes.push(start + (i * step) / 4);

    say('=== 1. REAL FRAME GRID (is this clip VFR?) ===', `probing ${probes.length} times from ${start.toFixed(3)}s at ${ms(step / 4)} granularity`);

    const t0 = Date.now();
    const thumbs = await player.generateThumbnailsAsync(probes, { maxWidth: 64 });
    const elapsed = Date.now() - t0;

    const distinct: number[] = [];
    for (const t of thumbs) {
      if (distinct.length === 0 || t.actualTime !== distinct[distinct.length - 1]) {
        distinct.push(t.actualTime);
      }
    }
    distinct.sort((a, b) => a - b);
    grid.current = distinct;

    const deltas: number[] = [];
    for (let i = 1; i < distinct.length; i += 1) deltas.push(distinct[i]! - distinct[i - 1]!);
    const min = Math.min(...deltas);
    const max = Math.max(...deltas);
    const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const spread = max - min;

    say(
      `  ${elapsed}ms for ${probes.length} thumbs (${(elapsed / probes.length).toFixed(1)}ms each)`,
      `  distinct frames  ${distinct.length}`,
      `  frame delta min  ${ms(min)}`,
      `  frame delta max  ${ms(max)}`,
      `  frame delta mean ${ms(mean)}   -> ${(1 / mean).toFixed(3)} fps measured`,
      `  spread           ${ms(spread)}`,
      spread < 0.0005
        ? '  VERDICT: constant frame rate. t + 1/fps is a safe step.'
        : '  VERDICT: VARIABLE frame rate. Stepping by 1/fps WILL drift —',
      spread < 0.0005 ? '' : '  frame times must be probed, not computed.',
      '  first 8 frame times:',
      ...distinct.slice(0, 8).map((t, i) => `    [${i}] ${t.toFixed(6)}s`),
      '',
    );
  });

  // ------------------------------------- 2 + 3. player seek accuracy

  const probeSeek = guard(async () => {
    if (grid.current.length < 6) {
      say('Run test 1 first — it establishes the frame grid this compares against.', '');
      return;
    }
    say(
      '=== 2. PLAYER SEEK: exact frame, or keyframe snap? ===',
      `seekTolerance = ${JSON.stringify(player.seekTolerance)} (expo-video default is 0/0)`,
      '  seeking to 40% INTO each frame, then reading currentTime back.',
      '  requested = the time we asked for',
      '  readback  = player.currentTime after the seek settles',
      '  true      = the frame that actually contains that time (thumbnail oracle)',
      '',
    );

    let echoes = 0;
    let reportsFrame = 0;
    for (let i = 0; i < 6; i += 1) {
      const frameStart = grid.current[i]!;
      const frameEnd = grid.current[i + 1]!;
      const requested = frameStart + (frameEnd - frameStart) * 0.4;

      player.currentTime = requested;
      const readback = await settle(player);

      const dTrue = readback - frameStart;
      const dReq = readback - requested;
      if (Math.abs(dReq) < 0.0002) echoes += 1;
      if (Math.abs(dTrue) < 0.0002) reportsFrame += 1;

      say(
        `  frame ${i}: requested ${requested.toFixed(6)}  readback ${readback.toFixed(6)}`,
        `           true frame ${frameStart.toFixed(6)}   readback-true ${ms(dTrue)}   readback-requested ${ms(dReq)}`,
      );
    }

    // A deliberately awkward target: an odd offset far from any likely keyframe.
    const odd = player.duration * 0.37 + 0.0123;
    player.currentTime = odd;
    const oddBack = await settle(player);
    const [oddTrue] = await player.generateThumbnailsAsync([odd], { maxWidth: 64 });

    say(
      '',
      '  awkward target, far from any keyframe:',
      `    requested ${odd.toFixed(6)}  readback ${oddBack.toFixed(6)}  true frame ${oddTrue!.actualTime.toFixed(6)}`,
      `    readback drifted ${ms(oddBack - oddTrue!.actualTime)} from the true frame`,
      '',
      '  ANSWER Q1 (does the seek land on the exact frame?):',
      Math.abs(oddBack - oddTrue!.actualTime) < 0.05
        ? '    No keyframe snap — the seek is frame-accurate.'
        : '    SNAPPED. The displayed frame is far from the request. Frame stepping',
      Math.abs(oddBack - oddTrue!.actualTime) < 0.05 ? '' : '    cannot be driven by currentTime alone.',
      '  ANSWER Q2 (does it report the DISPLAYED frame time?):',
      reportsFrame >= 5
        ? '    Yes — currentTime reports the frame PTS, not the request.'
        : echoes >= 5
          ? '    No — currentTime just echoes what we asked for. It is not a frame'
          : '    Mixed/ambiguous — see the per-frame rows above.',
      reportsFrame >= 5 || echoes < 5 ? '' : '    clock; use thumbnail actualTime as the source of truth.',
      '',
    );
  });

  // ------------------------------------------ 3. expo-video-thumbnails

  const probeLegacy = guard(async () => {
    if (!uri || grid.current.length < 3) {
      say('Run test 1 first.', '');
      return;
    }
    const frameStart = grid.current[1]!;
    const frameEnd = grid.current[2]!;
    const requested = frameStart + (frameEnd - frameStart) * 0.4;

    say('=== 3. expo-video-thumbnails vs expo-video ===');

    const t0 = Date.now();
    const legacy = await VideoThumbnails.getThumbnailAsync(uri, {
      time: Math.round(requested * 1000),
      quality: 0.5,
    });
    const legacyMs = Date.now() - t0;

    const t1 = Date.now();
    const [modern] = await player.generateThumbnailsAsync([requested], { maxWidth: 64 });
    const modernMs = Date.now() - t1;

    say(
      `  expo-video-thumbnails  ${legacyMs}ms  -> ${JSON.stringify(Object.keys(legacy))}`,
      `  expo-video             ${modernMs}ms  -> requested ${modern!.requestedTime.toFixed(6)} actualTime ${modern!.actualTime.toFixed(6)}`,
      '',
      '  Both set zero tolerance natively, so both return the EXACT frame.',
      '  But expo-video-thumbnails passes actualTime: nil and its result is',
      '  {uri, width, height} — it cannot tell you which frame you got. It also',
      '  takes an integer millisecond time (CMTimeMake timescale 1000) and writes',
      '  a full-resolution JPEG to disk on every call, with no maxWidth.',
      '',
    );
  });

  // --------------------------------------------------- 4. scrub cost

  const probeCost = guard(async () => {
    if (grid.current.length < 31) {
      say('Run test 1 first.', '');
      return;
    }
    say('=== 4. WHAT DOES SCRUBBING COST? ===');
    for (const maxWidth of [64, 320, 0]) {
      const opts = maxWidth ? { maxWidth } : undefined;
      const label = maxWidth ? `maxWidth ${maxWidth}` : 'full resolution';

      const t0 = Date.now();
      await player.generateThumbnailsAsync([grid.current[0]!], opts);
      const one = Date.now() - t0;

      const t1 = Date.now();
      await player.generateThumbnailsAsync(grid.current.slice(0, 30), opts);
      const thirty = Date.now() - t1;

      say(`  ${label.padEnd(16)} single ${String(one).padStart(5)}ms   batch of 30 ${String(thirty).padStart(5)}ms (${(thirty / 30).toFixed(1)}ms/frame)`);
    }
    say('', '  Batching matters: one generator, one decode session.', '');
  });

  const runAll = guard(async () => {
    await probeGrid();
    await probeSeek();
    await probeLegacy();
    await probeCost();
  });

  return (
    <View style={styles.root}>
      <View style={styles.videoBox}>
        {uri ? (
          <VideoView player={player} style={styles.video} nativeControls={false} contentFit="contain" />
        ) : (
          <Text style={styles.placeholder}>no clip</Text>
        )}
      </View>

      <View style={styles.row}>
        <Btn label="Pick clip" onPress={pick} busy={busy} />
        <Btn label="Run all" onPress={runAll} busy={busy || !uri} />
      </View>
      <View style={styles.row}>
        <Btn label="1 grid" onPress={probeGrid} busy={busy || !uri} />
        <Btn label="2 seek" onPress={probeSeek} busy={busy || !uri} />
        <Btn label="3 thumbs" onPress={probeLegacy} busy={busy || !uri} />
        <Btn label="4 cost" onPress={probeCost} busy={busy || !uri} />
      </View>

      <ScrollView style={styles.logBox} contentContainerStyle={styles.logPad}>
        <Text style={styles.log} selectable>
          {log.join('\n')}
        </Text>
      </ScrollView>
    </View>
  );
}

function Btn({ label, onPress, busy }: { label: string; onPress: () => void; busy: boolean }) {
  return (
    <Pressable style={[styles.btn, busy && styles.btnOff]} onPress={onPress} disabled={busy}>
      <Text style={styles.btnText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0e1116', paddingTop: 56, paddingHorizontal: 10 },
  videoBox: {
    height: 170,
    backgroundColor: '#000',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  video: { width: '100%', height: '100%' },
  placeholder: { color: '#475569', fontSize: 13 },
  row: { flexDirection: 'row', gap: 6, marginTop: 8 },
  btn: {
    flex: 1,
    backgroundColor: '#1e293b',
    borderRadius: 6,
    paddingVertical: 11,
    alignItems: 'center',
  },
  btnOff: { opacity: 0.4 },
  btnText: { color: '#e2e8f0', fontSize: 13, fontWeight: '600' },
  logBox: { flex: 1, marginTop: 10, backgroundColor: '#0b0e13', borderRadius: 8 },
  logPad: { padding: 10 },
  log: { color: '#cbd5e1', fontSize: 10, fontFamily: 'Menlo', lineHeight: 14 },
});
