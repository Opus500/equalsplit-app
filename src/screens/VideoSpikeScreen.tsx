// SPIKE — NOT PRODUCT CODE. Delete with the branch.
//
// Run 1 came back "Cannot Decode" (AVError -11821, AVErrorDecodeFailed) from
// generateThumbnailsAsync on BOTH pick routes. Both clips were HEVC (hvc1).
// The player read duration, size, codec and fps fine, so the file loads and
// decodes far enough to publish metadata — it is frame extraction that dies.
//
// This rewrite exists to name the cause in ONE more run rather than several.
// The original failing call varied five things at once (HEVC, 120 requests,
// quarter-frame spacing so four requests resolve to the same frame, maxWidth 64,
// and a 1.0s offset). So each is now isolated.
//
// The leading suspects, from reading the native source:
//
//   A. maximumSize = CGSize(64, 0). VideoThumbnailOptions.getMaxSize() builds
//      CGSize(width: maxWidth, height: maxHeight) with BOTH defaulting to 0, so
//      passing maxWidth alone yields a zero HEIGHT. If AVAssetImageGenerator
//      rejects that, it is an expo-video option-handling bug and the workaround
//      is to pass both dimensions. Cases 1-3 and 3b separate this.
//   B. HDR / 10-bit HEVC. iPhone records HLG by default. videoRange is now in
//      the header — if it reads 'hlg' or 'pq' that is the strongest single clue.
//   C. The shared player asset. generateThumbnailsAsync builds its generator from
//      `player.ref.currentItem?.asset` — the asset the AVPlayer is actively
//      holding. expo-video-thumbnails builds its OWN AVURLAsset, so if that
//      succeeds where this fails, contention is the cause. Test C, now decoupled.
//   D. Batch size or duplicate times. Cases 6-9.
//
// Test B is the important one for the FEATURE rather than the bug: it uses only
// seeking and currentTime readback, no thumbnail API at all. If it recovers a
// real frame grid, video timing is viable through the player alone and the
// thumbnail failure only costs us the filmstrip.

import { useCallback, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useVideoPlayer, VideoView, type VideoPlayer } from 'expo-video';
import * as ImagePicker from 'expo-image-picker';
import * as VideoThumbnails from 'expo-video-thumbnails';

// The REAL pure module, not a reimplementation — so what test D proves about the
// frame grid is proved about the code that will ship, the same way
// verify-migration.mjs rehearses the actual migration rather than a copy of it.
import { emptyGrid, ingestFrames, isVariableRate, measuredFps } from '../video/timing';

// ---------------------------------------------------------------- helpers

const sleep = (n: number) => new Promise((r) => setTimeout(r, n));
const ms = (seconds: number) => `${(seconds * 1000).toFixed(3)}ms`;
const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));

function errText(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: string }).code;
    return code ? `${e.message} [code ${code}]` : e.message;
  }
  return String(e);
}

// The previous version returned as soon as two reads 40ms apart matched — which
// for a PAUSED player is true instantly, before the seek has even started, so it
// was reading the pre-seek value. Now: require three consecutive identical reads
// AND a minimum elapsed time, so a settled value means the seek actually landed.
async function seekSettle(player: VideoPlayer, to: number, timeoutMs = 2000): Promise<number> {
  player.currentTime = to;
  const t0 = Date.now();
  let last = NaN;
  let stable = 0;
  while (Date.now() - t0 < timeoutMs) {
    await sleep(25);
    const now = player.currentTime;
    if (now === last) {
      stable += 1;
      if (stable >= 3 && Date.now() - t0 >= 120) return now;
    } else {
      stable = 0;
      last = now;
    }
  }
  return last;
}

type Pick = 'copy' | 'ph' | 'h264';

// ---------------------------------------------------------------- screen

export default function VideoSpikeScreen() {
  const [log, setLog] = useState<string[]>(['Pick a clip. Start with "Sweep".', '']);
  const [uri, setUri] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  // Unmounting VideoView releases the display layer. If the sweep passes with the
  // preview off and fails with it on, the cause is decoder/display contention.
  const [preview, setPreview] = useState(true);

  const fps = useRef(30);
  const grid = useRef<number[]>([]);
  const running = useRef(false);

  const player = useVideoPlayer(null, (p) => {
    p.muted = true;
    p.pause();
  });

  const say = useCallback((...lines: string[]) => setLog((prev) => [...prev, ...lines]), []);

  const guard = useCallback(
    (fn: () => Promise<void>) => async () => {
      if (running.current) return;
      running.current = true;
      setBusy(true);
      try {
        await fn();
      } catch (e) {
        say(`!! ${errText(e)}`, '');
      } finally {
        running.current = false;
        setBusy(false);
      }
    },
    [say],
  );

  // ------------------------------------------------------------- pick

  const pickWith = (kind: Pick) =>
    guard(async () => {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        say('Photo library permission denied.', '');
        return;
      }
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['videos'],
        allowsEditing: false,
        // H264_1280x720 forces a re-encode to H.264, which is the whole point of
        // that button: same source content, different codec, so the codec variable
        // is isolated without needing a second recording.
        videoExportPreset:
          kind === 'h264'
            ? ImagePicker.VideoExportPreset.H264_1280x720
            : ImagePicker.VideoExportPreset.Passthrough,
        // Only consulted on the Passthrough path; harmless otherwise.
        shouldDownloadFromNetwork: true,
      });
      if (res.canceled || !res.assets[0]) return;

      const asset = res.assets[0];
      const source = kind === 'ph' && asset.assetId ? `ph://${asset.assetId}` : asset.uri;

      grid.current = [];
      setUri(kind === 'ph' ? null : asset.uri);
      setLoaded(false);
      await player.replaceAsync(source);
      setLoaded(true);
      await sleep(500);

      const track = player.videoTrack ?? player.availableVideoTracks[0] ?? null;
      fps.current = track?.frameRate ?? 30;
      const range = track?.videoRange ?? '?';

      setLog([
        `=== CLIP (${kind}) ===`,
        `source        ${source.slice(-46)}`,
        `codec         ${track?.mimeType ?? '?'}`,
        `videoRange    ${range}   ${range !== 'sdr' ? '<<< HDR / 10-bit. Prime suspect for the decode failure.' : '(SDR)'}`,
        `size          ${track?.size ? `${track.size.width}x${track.size.height}` : '?'}`,
        `nominal fps   ${fps.current}`,
        `duration      ${player.duration.toFixed(4)}s`,
        `file size     ${asset.fileSize ?? '?'} bytes`,
        '',
        kind === 'h264'
          ? 'This clip was RE-ENCODED to H.264. If the sweep passes here and fails'
          : '',
        kind === 'h264' ? 'on the same clip picked as "copy", the cause is the codec.' : '',
        '',
      ]);
    });

  // ------------------------------------------- A. the decode sweep

  const sweep = useCallback(async () => {
    const step = 1 / fps.current;
    const mid = Math.max(0, player.duration / 2);

    type Case = {
      name: string;
      n: number;
      w: number;
      h: number;
      at: number;
      spacing: number;
    };
    const cases: Case[] = [
      { name: '1 frame  @1.0s  no maxSize', n: 1, w: 0, h: 0, at: 1.0, spacing: 1 },
      { name: '1 frame  @1.0s  maxW 320', n: 1, w: 320, h: 0, at: 1.0, spacing: 1 },
      { name: '1 frame  @1.0s  maxW 64', n: 1, w: 64, h: 0, at: 1.0, spacing: 1 },
      { name: '1 frame  @1.0s  maxW+H 64', n: 1, w: 64, h: 64, at: 1.0, spacing: 1 },
      { name: '1 frame  @0.0s  no maxSize', n: 1, w: 0, h: 0, at: 0, spacing: 1 },
      { name: '1 frame  @mid   no maxSize', n: 1, w: 0, h: 0, at: mid, spacing: 1 },
      { name: '5 frames @1.0s  1 frame apart', n: 5, w: 0, h: 0, at: 1.0, spacing: 1 },
      { name: '5 frames @1.0s  1/4 frame apart', n: 5, w: 0, h: 0, at: 1.0, spacing: 0.25 },
      { name: '30 frames@1.0s  1 frame apart', n: 30, w: 0, h: 0, at: 1.0, spacing: 1 },
      { name: '120 frm  1/4 apart maxW 64', n: 120, w: 64, h: 0, at: 1.0, spacing: 0.25 },
    ];

    say(
      '=== A. DECODE SWEEP ===',
      `preview ${preview ? 'ON' : 'OFF'} · fps ${fps.current.toFixed(3)} · one variable at a time`,
      '',
    );

    let firstOk: string | null = null;
    for (const c of cases) {
      const times: number[] = [];
      for (let i = 0; i < c.n; i += 1) times.push(c.at + i * step * c.spacing);
      const opts: { maxWidth?: number; maxHeight?: number } = {};
      if (c.w) opts.maxWidth = c.w;
      if (c.h) opts.maxHeight = c.h;

      const t0 = Date.now();
      try {
        const out = await player.generateThumbnailsAsync(times, c.w || c.h ? opts : undefined);
        const el = Date.now() - t0;
        const distinct = new Set(out.map((t) => t.actualTime)).size;
        say(`  OK   ${pad(c.name, 32)} ${String(el).padStart(5)}ms  got ${out.length}, ${distinct} distinct`);
        if (!firstOk) firstOk = c.name;
      } catch (e) {
        say(`  FAIL ${pad(c.name, 32)} ${errText(e)}`);
      }
    }

    say(
      '',
      firstOk
        ? `  First working config: ${firstOk}`
        : '  NOTHING worked. Frame extraction is unavailable for this clip via expo-video.',
      '',
      '  How to read this:',
      '   - only the maxW 64 rows fail  -> expo-video bug: getMaxSize() makes',
      '     CGSize(64, 0) with a ZERO height. Workaround: pass maxWidth AND maxHeight.',
      '   - all rows fail, H.264 clip passes -> the codec/HDR is the cause.',
      '   - small n passes, large n fails -> batch/decoder pressure; chunk the requests.',
      '   - 1/4-apart fails but 1-apart passes -> duplicate times per frame.',
      '   - all fail here but test C passes -> contention with the player asset.',
      '',
    );
  }, [player, preview, say]);

  // ---------------------------- B. PLAYER ONLY — no thumbnail API at all

  const playerOnly = useCallback(async () => {
    const step = 1 / fps.current;
    const start = Math.min(1.0, player.duration / 3);

    say(
      '=== B. PLAYER ONLY (seek + currentTime, no thumbnails) ===',
      `  seekTolerance ${JSON.stringify(player.seekTolerance)}`,
      '  20 seeks a quarter-frame apart. If currentTime reports the DISPLAYED',
      '  frame, the readbacks collapse onto a grid ~1 frame apart. If it merely',
      '  echoes the request, all 20 come back distinct and equal to what we asked.',
      '',
    );

    const rows: { req: number; got: number }[] = [];
    for (let i = 0; i < 20; i += 1) {
      const req = start + (i * step) / 4;
      const got = await seekSettle(player, req);
      rows.push({ req, got });
    }

    let echoes = 0;
    for (const r of rows) if (Math.abs(r.got - r.req) < 0.0002) echoes += 1;

    const distinct: number[] = [];
    for (const r of rows) {
      if (!distinct.length || Math.abs(r.got - distinct[distinct.length - 1]!) > 0.0002) {
        distinct.push(r.got);
      }
    }

    say(...rows.slice(0, 8).map((r, i) => `  [${String(i).padStart(2)}] req ${r.req.toFixed(6)}  got ${r.got.toFixed(6)}  d ${ms(r.got - r.req)}`));

    const deltas: number[] = [];
    for (let i = 1; i < distinct.length; i += 1) deltas.push(distinct[i]! - distinct[i - 1]!);
    const mean = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;

    if (echoes >= 18) {
      say(
        '',
        '  VERDICT: currentTime ECHOES the request. It is not a frame clock.',
        '  Player-only marking would be blind to frame boundaries: you could seek',
        '  precisely but never know WHICH frame you are on, so stepping would have',
        '  to assume 1/fps and would drift on any variable-frame-rate clip.',
        '',
      );
    } else if (distinct.length >= 3 && distinct.length <= 12) {
      say(
        '',
        `  distinct readbacks ${distinct.length} of 20`,
        `  mean spacing       ${ms(mean)}  -> ${(1 / mean).toFixed(2)} fps`,
        `  nominal fps        ${fps.current.toFixed(3)}`,
        '  VERDICT: currentTime reports the FRAME, not the request. A real frame',
        '  grid is recoverable from the player alone — video timing is viable',
        '  without any thumbnail API. Only the filmstrip still needs images.',
        '',
      );
    } else {
      say('', `  Inconclusive: ${distinct.length} distinct readbacks, ${echoes} echoes.`, '');
    }
    grid.current = distinct;
  }, [player, say]);

  // ------------------ C. expo-video-thumbnails — its OWN asset, decoupled

  const legacy = useCallback(async () => {
    say('=== C. expo-video-thumbnails (builds its own AVURLAsset) ===');
    if (!uri) {
      say('  Needs a file path — re-pick with "copy" or "H.264". ph:// cannot be read here.', '');
      return;
    }
    for (const at of [0, 1.0, Math.max(0, player.duration / 2)]) {
      const t0 = Date.now();
      try {
        const r = await VideoThumbnails.getThumbnailAsync(uri, {
          time: Math.round(at * 1000),
          quality: 0.5,
        });
        say(`  OK   @${at.toFixed(2)}s  ${Date.now() - t0}ms  ${r.width}x${r.height}`);
      } catch (e) {
        say(`  FAIL @${at.toFixed(2)}s  ${errText(e)}`);
      }
    }
    say(
      '',
      '  If these pass while sweep A fails, the cause is that expo-video builds its',
      '  generator from the LIVE player item asset. If both fail, it is the file.',
      '',
    );
  }, [uri, player, say]);

  // ------------------------- D. SEQUENTIAL single-frame calls

  /** One frame, one call. Returns ms taken and the actualTime, or null on failure. */
  const oneFrame = useCallback(
    async (t: number, maxWidth?: number): Promise<{ ms: number; actual: number } | null> => {
      const t0 = Date.now();
      try {
        const [th] = await player.generateThumbnailsAsync(
          [t],
          maxWidth ? { maxWidth, maxHeight: maxWidth } : undefined,
        );
        return th ? { ms: Date.now() - t0, actual: th.actualTime } : null;
      } catch {
        return null;
      }
    },
    [player],
  );

  const sequential = useCallback(async () => {
    const step = 1 / fps.current;
    say(
      '=== D. SEQUENTIAL SINGLE-FRAME CALLS ===',
      `preview ${preview ? 'ON' : 'OFF'}`,
      '  Batches die above n=1, so this is the whole plan: loop one at a time.',
      '',
    );

    // --- D1: consecutive frames, as frame-stepping near a mark would ask.
    const t0 = Date.now();
    const results: { ms: number; actual: number }[] = [];
    let failed = 0;
    for (let i = 0; i < 30; i += 1) {
      const r = await oneFrame(1.0 + i * step, 160);
      if (r) results.push(r);
      else failed += 1;
    }
    const wall = Date.now() - t0;
    const per = results.length ? results.reduce((a, b) => a + b.ms, 0) / results.length : 0;

    // Fed through the SHIPPING grid code, so a pass here is a pass for the module.
    let grid = emptyGrid();
    grid = ingestFrames(grid, { from: 1.0, to: 1.0 + 30 * step }, results.map((r) => r.actual));
    const mfps = measuredFps(grid);

    say(
      '  D1 consecutive frames (stepping):',
      `    ${results.length}/30 succeeded, ${failed} failed`,
      `    per call  ${per.toFixed(1)}ms      total ${wall}ms`,
      `    distinct frames ${grid.frames.length}`,
      `    measured fps    ${mfps ? mfps.toFixed(3) : 'n/a'}   nominal ${fps.current.toFixed(3)}`,
      `    variable rate   ${isVariableRate(grid) ? 'YES — 1/fps stepping would drift' : 'no, constant'}`,
      '',
    );

    if (!results.length) {
      say('  Sequential does NOT work either. That is rung 4: the Swift module.', '');
      return;
    }

    // --- D2: scattered across the clip, as a filmstrip would ask.
    // The comparison is the point. expo-video builds a NEW AVAssetImageGenerator on
    // every call, so no decode session survives between them — if that is true,
    // a neighbouring frame costs the same as one a minute away, because both pay
    // the full decode from the preceding keyframe.
    const t1 = Date.now();
    const scattered: number[] = [];
    let sFailed = 0;
    for (let i = 0; i < 30; i += 1) {
      const r = await oneFrame((i * player.duration) / 30, 160);
      if (r) scattered.push(r.ms);
      else sFailed += 1;
    }
    const sWall = Date.now() - t1;
    const sPer = scattered.length ? scattered.reduce((a, b) => a + b, 0) / scattered.length : 0;

    say(
      '  D2 scattered across the clip (filmstrip):',
      `    ${scattered.length}/30 succeeded, ${sFailed} failed`,
      `    per call  ${sPer.toFixed(1)}ms      total ${sWall}ms`,
      sPer > per * 1.6
        ? '    Scattered is MUCH dearer -> neighbouring frames do reuse something.'
        : '    Scattered costs about the same as consecutive -> NO decode reuse.',
      sPer > per * 1.6 ? '' : '    Every call pays keyframe-to-target. Stepping is as dear as scrubbing.',
      '',
    );

    // --- D3: does tile size change the cost? Decides whether small tiles are cheap.
    say('  D3 cost by tile size (10 calls each):');
    for (const w of [64, 160, 0]) {
      const t2 = Date.now();
      let ok = 0;
      for (let i = 0; i < 10; i += 1) {
        if (await oneFrame(1.0 + i * step * 7, w || undefined)) ok += 1;
      }
      const el = Date.now() - t2;
      say(`    ${(w ? `maxSize ${w}` : 'full size').padEnd(14)} ${ok}/10  ${(el / 10).toFixed(1)}ms each`);
    }

    // --- D4: can single calls run CONCURRENTLY? Each JS call builds its own
    // generator, so this both probes the batch failure's mechanism and offers a
    // straight multiplier on filmstrip build time if it holds.
    const t3 = Date.now();
    const par = await Promise.all(
      [0, 1, 2, 3, 4].map((i) => oneFrame(1.0 + i * step * 11, 160)),
    );
    const parWall = Date.now() - t3;
    const parOk = par.filter(Boolean).length;
    say(
      '',
      `  D4 five calls in PARALLEL: ${parOk}/5 in ${parWall}ms`,
      parOk === 5
        ? '    Concurrency is fine -> a filmstrip can fan out and divide the wall time.'
        : '    Parallel fails like a batch -> the fault is concurrent generators on the',
      parOk === 5 ? '' : '    shared player asset. Sequential is the only safe shape.',
      '',
    );

    // --- What this means for the actual screen.
    // MEASURED speedup, not the fan-out width. An earlier version of this printed
    // "divided by ~5", which was wrong: five concurrent calls returning in 77ms
    // against a 27.7ms serial cost is 1.8x, not 5x — the hardware decoder
    // serialises most of the work. Run E for the actual knee.
    const cheapest = Math.min(per, sPer);
    const parSpeedup = parOk === 5 && parWall > 0 ? (cheapest * 5) / parWall : 1;
    say(
      '  PROJECTION at the measured rate:',
      `    measured fan-out speedup at width 5: ${parSpeedup.toFixed(2)}x`,
      `    20-tile filmstrip   ${((cheapest * 20) / 1000).toFixed(2)}s  ->  ${((cheapest * 20) / parSpeedup / 1000).toFixed(2)}s fanned out`,
      `    60-tile filmstrip   ${((cheapest * 60) / 1000).toFixed(2)}s  ->  ${((cheapest * 60) / parSpeedup / 1000).toFixed(2)}s fanned out`,
      `    12-frame step window ${((cheapest * 12) / 1000).toFixed(2)}s  ->  ${((cheapest * 12) / parSpeedup / 1000).toFixed(2)}s fanned out`,
      '',
    );
  }, [player, preview, oneFrame, say]);

  // ------------------------------- E. where does fan-out stop paying?

  const fanOut = useCallback(async () => {
    const step = 1 / fps.current;
    say(
      '=== E. FAN-OUT WIDTH ===',
      '  12 calls at each width, chunked. Width 1 is the serial baseline.',
      '  Looking for the knee: one hardware decoder means this flattens early,',
      '  and past the knee the only thing wider buys is memory pressure.',
      '',
    );
    let baseline = 0;
    for (const width of [1, 2, 4, 8, 12]) {
      const t0 = Date.now();
      let ok = 0;
      for (let i = 0; i < 12; i += width) {
        const chunk = [];
        for (let j = 0; j < width && i + j < 12; j += 1) {
          chunk.push(oneFrame(1.0 + (i + j) * step * 5, 160));
        }
        ok += (await Promise.all(chunk)).filter(Boolean).length;
      }
      const el = Date.now() - t0;
      if (width === 1) baseline = el;
      say(
        `  width ${String(width).padStart(2)}  ${ok}/12  ${String(el).padStart(5)}ms total  ` +
          `${(el / 12).toFixed(1)}ms/call  ${baseline ? `${(baseline / el).toFixed(2)}x` : ''}`,
      );
    }
    say('', '  Pick the smallest width within ~10% of the best — wider costs memory', '  for nothing.', '');
  }, [oneFrame, say]);

  const runAll = guard(async () => {
    await sweep();
    await playerOnly();
    await legacy();
    await sequential();
  });

  return (
    <View style={styles.root}>
      <View style={styles.videoBox}>
        {loaded && preview ? (
          <VideoView player={player} style={styles.video} nativeControls={false} contentFit="contain" />
        ) : (
          <Text style={styles.placeholder}>{loaded ? 'preview detached' : 'no clip'}</Text>
        )}
      </View>

      <View style={styles.row}>
        <Btn label="Pick copy" onPress={pickWith('copy')} off={busy} />
        <Btn label="Pick ph://" onPress={pickWith('ph')} off={busy} />
        <Btn label="Pick H.264" onPress={pickWith('h264')} off={busy} />
      </View>
      <View style={styles.row}>
        <Btn label={preview ? 'Preview ON' : 'Preview OFF'} onPress={() => setPreview((p) => !p)} off={busy} />
        <Btn label="Run all" onPress={runAll} off={busy || !loaded} />
      </View>
      <View style={styles.row}>
        <Btn label="A sweep" onPress={guard(sweep)} off={busy || !loaded} />
        <Btn label="B player" onPress={guard(playerOnly)} off={busy || !loaded} />
        <Btn label="C thumbs" onPress={guard(legacy)} off={busy || !loaded} />
        <Btn label="D seq" onPress={guard(sequential)} off={busy || !loaded} />
        <Btn label="E fan" onPress={guard(fanOut)} off={busy || !loaded} />
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
  videoBox: {
    height: 150,
    backgroundColor: '#000',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  video: { width: '100%', height: '100%' },
  placeholder: { color: '#475569', fontSize: 13 },
  row: { flexDirection: 'row', gap: 6, marginTop: 8 },
  btn: { flex: 1, backgroundColor: '#1e293b', borderRadius: 6, paddingVertical: 11, alignItems: 'center' },
  btnOff: { opacity: 0.4 },
  btnText: { color: '#e2e8f0', fontSize: 12, fontWeight: '600' },
  logBox: { flex: 1, marginTop: 10, backgroundColor: '#0b0e13', borderRadius: 8 },
  logPad: { padding: 10 },
  log: { color: '#cbd5e1', fontSize: 10, fontFamily: 'Menlo', lineHeight: 14 },
});
