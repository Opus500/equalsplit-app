// Stage 1: import a clip, mark two frames, save a time.
//
// The interaction is the Photos trimmer: a filmstrip you drag two handles across.
// The large preview is VideoView with a zero-tolerance seek, so what is on screen
// IS the frame being marked — no image extraction is involved in the preview at
// all. Extraction is used for two things only: the tiles under the handles, and
// the true presentation timestamps that make the time a measurement rather than a
// reading of where a finger happened to stop.
//
// WHY THE HANDLES SNAP: a drag gives a position in seconds, but a mark has to be a
// FRAME. Every dragged position is resolved through the measured grid to the frame
// actually displayed at that instant, and the time is computed from that frame's
// timestamp. Without that the recorded time would be the scrubber's precision
// rather than the video's.
//
// Accuracy is stated, never implied. The +/- comes from the two marked frames'
// measured durations, and the decimals shown follow from it — a 30fps clip is not
// allowed to print a hundredths digit it cannot support.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  type LayoutChangeEvent,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';

import { AthletePickerModal } from '../components/AthletePicker';
import { DrillPickerModal } from '../components/DrillPicker';
import { saveRun, type Drill } from '../db/database';
import { useRoster } from '../roster/RosterProvider';
import { deleteClip, formatBytes, importClip, type Clip } from '../video/clips';
import { filmstrip, nominalFrameDur, probeGridAround, type Tile } from '../video/frames';
import {
  BODY_PART_BIAS_MS,
  emptyGrid,
  formatVideoSeconds,
  isVariableRate,
  markAt,
  measuredFps,
  seekTimeFor,
  stepFrames,
  timeFromMarks,
  videoRunRawJson,
  VIDEO_MODE,
  type FrameGrid,
  type VideoMark,
} from '../video/timing';

const STRIP_H = 56;
const TILE_COUNT = 14;
/**
 * Floor on the gap between live scrub seeks, in ms.
 *
 * ~16/second. Move events arrive at about 60Hz and a seek per event would thrash
 * the decoder; below roughly this rate the preview stops reading as live. Paired
 * with a half-frame filter, so a move that does not change the displayed frame
 * costs nothing at all.
 */
const DRAG_SEEK_MS = 60;
/** Handle width; also the minimum comfortable drag target. */
const HANDLE_W = 22;

type Which = 'start' | 'finish';

export default function VideoMarkScreen({ onSaved }: { onSaved?: (ms: number) => void }) {
  const [clip, setClip] = useState<Clip | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [stripW, setStripW] = useState(0);
  const [grid, setGrid] = useState<FrameGrid>(emptyGrid());
  // Positions in SECONDS. The authoritative marks are derived from these through
  // the grid — these are just where the fingers are.
  const [startAt, setStartAt] = useState(0);
  const [finishAt, setFinishAt] = useState(0);
  const [dragging, setDragging] = useState<Which | null>(null);
  const [drill, setDrill] = useState<Drill | null>(null);
  const [pickingDrill, setPickingDrill] = useState(false);
  const [pickingAthlete, setPickingAthlete] = useState(false);
  /**
   * undefined = follow the lineup. A string or null = the coach chose, including
   * choosing Unassigned.
   *
   * BOTH, not one or the other. A gate run is timed live, so the lineup cursor is
   * authoritative by construction — whoever is up is who just ran. A video run is
   * usually marked afterwards, sitting down, from a clip of someone who may be
   * three places back in the lineup by now. Defaulting to the lineup keeps the
   * common case one tap; allowing an override is what stops the uncommon case from
   * silently attributing a run to the wrong athlete.
   */
  const [athleteOverride, setAthleteOverride] = useState<string | null | undefined>(undefined);
  const roster = useRoster();

  const athleteId = athleteOverride !== undefined ? athleteOverride : (roster.currentAthlete?.id ?? null);
  const athlete = roster.byId(athleteId);
  const followingLineup = athleteOverride === undefined;

  const player = useVideoPlayer(null, (p) => {
    p.muted = true;
    p.pause();
  });

  const duration = player.duration || 0;
  const frameDur = useMemo(() => (clip ? nominalFrameDur(player) : 1 / 30), [clip, player]);

  // Latest values for the pan responder, which is created once and would
  // otherwise close over the first render's state.
  const live = useRef({ stripW: 0, duration: 0, startAt: 0, finishAt: 0 });
  live.current = { stripW, duration, startAt, finishAt };
  /** The handle's position when the drag STARTED. See onPanResponderGrant. */
  const dragBase = useRef(0);
  /** Live-scrub bookkeeping: throttle state plus what the seeks actually cost, so
   *  "is a seek per drag event affordable" is answered with a number. */
  const dragSeeks = useRef({ n: 0, ms: 0, lastAt: 0, lastT: -1 });
  /** What each interaction actually cost, shown on screen so "it feels slow" can
   *  be answered with a number instead of a guess. */
  const [perf, setPerf] = useState<string | null>(null);

  // ------------------------------------------------------------- import

  const pick = useCallback(async () => {
    setBusy('Importing…');
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Photo access needed', 'EqualSplit needs to read the clip you recorded.');
        return;
      }
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['videos'],
        allowsEditing: false,
        // Passthrough copies the original bytes. A transcode would re-encode to a
        // constant frame rate and quietly change the very timings being measured.
        videoExportPreset: ImagePicker.VideoExportPreset.Passthrough,
        // Required with Passthrough: that path streams the original resource via
        // PHAssetResourceManager, whose network access is bound to this flag, and
        // without it local clips fail with PHPhotosError 3164.
        shouldDownloadFromNetwork: true,
      });
      if (res.canceled || !res.assets[0]) return;

      const imported = await importClip(res.assets[0].uri);
      setClip(imported);
      setGrid(emptyGrid());
      setTiles([]);
      await player.replaceAsync(imported.uri);
      // Let the tracks load before anything reads duration or frame rate.
      await new Promise((r) => setTimeout(r, 400));
      const d = player.duration || 0;
      setStartAt(0);
      setFinishAt(d);
    } catch (e) {
      Alert.alert('Could not import that clip', String(e));
    } finally {
      setBusy(null);
    }
  }, [player]);

  // ------------------------------------------------------- strip + grid

  // Tiles for the whole clip. Cheap at this count, and rebuilt rather than cached:
  // ~14 tiles at ~24ms with a fan of 8 is a couple of hundred ms, against megabytes
  // per clip to store — and keeping storage to the clip alone is what makes the
  // size shown at the delete point exactly what deleting reclaims.
  useEffect(() => {
    if (!clip || !duration) return;
    let alive = true;
    setBusy('Building filmstrip…');
    filmstrip(player, 0, duration, TILE_COUNT)
      .then((t) => alive && setTiles(t))
      .catch(() => alive && setTiles([]))
      .finally(() => alive && setBusy(null));
    return () => {
      alive = false;
    };
  }, [clip, duration, player]);

  /** Probe the frame grid around a position, then seek to the frame it resolves to. */
  const settleAt = useCallback(
    async (seconds: number) => {
      if (!clip) return;
      const r = await probeGridAround(player, grid, seconds, frameDur);
      setGrid(r.grid);
      const m = markAt(r.grid, seconds);
      const t0 = Date.now();
      // Seek to the frame's MIDDLE — a request on a boundary is decided by float
      // representation and can show the frame before.
      player.currentTime = m ? seekTimeFor(m) : seconds;
      const d = dragSeeks.current;
      setPerf(
        `probe ${r.ms}ms/${r.calls} · seek ${Date.now() - t0}ms` +
          (d.n ? ` · drag ${d.n} seeks, ${(d.ms / d.n).toFixed(1)}ms each` : ''),
      );
    },
    [clip, grid, player, frameDur],
  );

  const startMark: VideoMark | null = useMemo(() => markAt(grid, startAt), [grid, startAt]);
  const finishMark: VideoMark | null = useMemo(() => markAt(grid, finishAt), [grid, finishAt]);
  const timing = useMemo(
    () => (startMark && finishMark ? timeFromMarks(startMark, finishMark) : null),
    [startMark, finishMark],
  );

  // While dragging, the grid around the finish handle usually is not probed yet, so
  // show the raw span. It is the right number to within a frame and it updates on
  // every move, which is what "see it change as they scrub" needs; the moment the
  // finger lifts it is replaced by the frame-accurate one.
  const liveMs = timing ? timing.elapsedMs : (finishAt - startAt) * 1000;
  const decimals = timing ? timing.decimals : 1;

  // ------------------------------------------------------------ drag

  const responderFor = (which: Which) =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // THE FIX FOR VERTICAL DRIFT. The handles live inside a vertical ScrollView,
      // and RN's responder negotiation lets that parent ASK to take over as soon as
      // it sees vertical movement — which it always does, because fingers do not
      // travel in straight lines. Refusing the request keeps the gesture here for
      // its whole life. `scrollEnabled` is also switched off while dragging, so the
      // parent never competes in the first place.
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
      onPanResponderGrant: () => {
        // The origin is captured ONCE, here. gestureState.dx is cumulative from
        // this moment, so reading the base from live state on every move re-adds
        // the whole displacement to a position that already contains it — which
        // compounds, and is why a 20pt drag crossed most of the strip.
        dragBase.current = which === 'start' ? live.current.startAt : live.current.finishAt;
        dragSeeks.current = { n: 0, ms: 0, lastAt: 0, lastT: -1 };
        // Scrubbing mode plus a LOOSE tolerance for the duration of the drag. A
        // zero-tolerance seek must decode from the preceding keyframe, which is the
        // ~25ms we measured — fine once, ruinous at 60Hz. While a finger is moving
        // the coach needs responsiveness, not frame accuracy; the exact frame is
        // resolved on release, which is the only moment it means anything.
        player.scrubbingModeOptions = { scrubbingModeEnabled: true };
        player.seekTolerance = { toleranceBefore: 0.05, toleranceAfter: 0.05 };
        setDragging(which);
      },
      onPanResponderMove: (_e, g) => {
        const { stripW: w, duration: d } = live.current;
        if (!w || !d) return;
        let next = dragBase.current + (g.dx / w) * d;
        next = Math.max(0, Math.min(d, next));
        // The handles cannot cross. A finish before a start is not a measurement
        // to warn about later, it is a state to prevent now.
        const clamped =
          which === 'start'
            ? Math.min(next, live.current.finishAt - frameDur)
            : Math.max(next, live.current.startAt + frameDur);
        if (which === 'start') setStartAt(clamped);
        else setFinishAt(clamped);

        // Two gates before seeking. Time-based so the decoder is never asked for
        // more than ~16 seeks a second, and frame-based so a move that has not
        // changed which frame is displayed does no work at all.
        const now = Date.now();
        const s = dragSeeks.current;
        if (now - s.lastAt < DRAG_SEEK_MS) return;
        if (Math.abs(clamped - s.lastT) < frameDur / 2) return;
        s.lastAt = now;
        s.lastT = clamped;
        const t0 = Date.now();
        player.currentTime = clamped;
        s.ms += Date.now() - t0;
        s.n += 1;
      },
      onPanResponderRelease: () => {
        setDragging(null);
        // Back to frame-accurate for the settle. Leaving a loose tolerance in place
        // would silently make every later seek land on the wrong frame.
        player.scrubbingModeOptions = { scrubbingModeEnabled: false };
        player.seekTolerance = { toleranceBefore: 0, toleranceAfter: 0 };
        void settleAt(which === 'start' ? live.current.startAt : live.current.finishAt);
      },
      // A terminate still has to restore the player, or a gesture stolen by the
      // system would leave loose tolerances behind for good.
      onPanResponderTerminate: () => {
        setDragging(null);
        player.scrubbingModeOptions = { scrubbingModeEnabled: false };
        player.seekTolerance = { toleranceBefore: 0, toleranceAfter: 0 };
      },
    });

  // Rebuilt when settleAt changes so the release handler never probes a stale grid.
  const startPan = useMemo(() => responderFor('start'), [settleAt, frameDur]);
  const finishPan = useMemo(() => responderFor('finish'), [settleAt, frameDur]);

  const step = useCallback(
    async (which: Which, delta: number) => {
      const at = which === 'start' ? startAt : finishAt;
      const r = await probeGridAround(player, grid, at, frameDur);
      setGrid(r.grid);
      const m = stepFrames(r.grid, at, delta);
      if (!m) return;
      if (which === 'start') setStartAt(m.pts);
      else setFinishAt(m.pts);
      const t0 = Date.now();
      player.currentTime = seekTimeFor(m);
      setPerf(`probe ${r.ms}ms / ${r.calls} calls · seek ${Date.now() - t0}ms`);
    },
    [startAt, finishAt, grid, player, frameDur],
  );

  // ------------------------------------------------------------- save

  /**
   * Write the run.
   *
   * Goes through saveRun exactly like every other write path, so a video run lands
   * in History, links to the athlete, and resolves its drill record — the whole
   * point of not inventing a parallel storage path for it. mode 5 and the raw_json
   * facts are what make it a VIDEO run; nothing else about the write differs.
   *
   * split1/split2 are 0: a video run is one time, and mode is what says so.
   */
  const save = useCallback(
    async (keepVideo: boolean) => {
      if (!timing || !clip || !startMark || !finishMark) return;
      if (!drill) {
        Alert.alert('Pick a drill first', 'Without one the run cannot be charted.');
        return;
      }
      setBusy('Saving…');
      try {
        await saveRun({
          mode: VIDEO_MODE,
          totalMs: Math.round(timing.elapsedMs),
          split1Ms: 0,
          split2Ms: 0,
          athleteId,
          drillType: drill.name,
          rawJson: videoRunRawJson({
            startPts: startMark.pts,
            endPts: finishMark.pts,
            // MEASURED, not the track's nominal figure — a clip reporting 25.5fps
            // is telling you it is variable, and the row should record what was
            // actually observed between the marks.
            fps: measuredFps(grid) ?? 1 / frameDur,
            quantSdMs: timing.quantSdMs,
            clipId: keepVideo ? clip.id : null,
          }),
        });
        // Only after the row is safely written. Discarding first would risk losing
        // the video to a failed save.
        if (!keepVideo) deleteClip(clip.id);
        // Advance the lineup ONLY when this run belongs to whoever is up. Marking
        // an old clip for someone three places back must not move the cursor —
        // that would skip a live athlete's turn on the strength of a desk job.
        if (athleteId && athleteId === roster.currentAthlete?.id) roster.completeRun();
        onSaved?.(timing.elapsedMs);
        Alert.alert(
          'Time recorded',
          `${formatVideoSeconds(timing.elapsedMs, timing.decimals)}s · ${drill.name}\n\n` +
            (keepVideo ? 'Video kept in the app.' : 'Video discarded, time kept.'),
        );
        setClip(null);
        setTiles([]);
        setGrid(emptyGrid());
      } catch (e) {
        Alert.alert('Could not save', String(e));
      } finally {
        setBusy(null);
      }
    },
    // athleteId, not just roster: it is derived from athleteOverride too, and
    // leaving it out would let a stale closure attribute the run to whoever was
    // selected before the coach changed it.
    [timing, clip, startMark, finishMark, grid, frameDur, drill, athleteId, roster, onSaved],
  );

  // ------------------------------------------------------------ render

  const x = (t: number) => (duration ? (t / duration) * Math.max(0, stripW - HANDLE_W) : 0);

  return (
    // Column, not a ScrollView: the preview must TAKE the leftover space rather
    // than sit at a fixed height above scrollable content. Judging a foot against
    // a cone is the whole task, and it cannot be done on a thumbnail — so the
    // preview gets everything the controls do not need.
    <View style={styles.root}>
      <View style={styles.preview}>
        {clip ? (
          <VideoView player={player} style={styles.video} nativeControls={false} contentFit="contain" />
        ) : (
          <Text style={styles.placeholder}>No clip yet</Text>
        )}
        {busy ? (
          <View style={styles.busy}>
            <ActivityIndicator color="#93c5fd" />
            <Text style={styles.busyText}>{busy}</Text>
          </View>
        ) : null}
        {/* Overlaid on the video rather than given its own row: it is the answer
            the coach came for and it has to be readable without taking space from
            the thing being judged. */}
        {clip ? (
          <View style={styles.readout}>
            <Text style={styles.elapsed}>{formatVideoSeconds(liveMs, decimals)}s</Text>
            <Text style={styles.pm}>
              {timing ? `± ${timing.quantSdMs.toFixed(0)}ms` : 'release to snap'}
            </Text>
          </View>
        ) : null}
      </View>

      {!clip ? (
        <View style={styles.controls}>
          <Pressable style={styles.primary} onPress={pick}>
            <Text style={styles.primaryText}>Import a clip</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView
          style={styles.controls}
          contentContainerStyle={styles.controlsBody}
          // Belt and braces with onPanResponderTerminationRequest: with scrolling
          // off there is nothing for the drag to compete against.
          scrollEnabled={!dragging}
        >
          <View
            style={styles.strip}
            onLayout={(e: LayoutChangeEvent) => setStripW(e.nativeEvent.layout.width)}
          >
            {tiles.map((t, i) => (
              <Image
                key={`${t.actualTime}-${i}`}
                source={t.ref as never}
                style={[styles.tile, { width: stripW / Math.max(1, tiles.length) }]}
                contentFit="cover"
              />
            ))}
            {/* Everything outside the marks is dimmed, so the selection reads as a
                span rather than as two unrelated handles. */}
            <View pointerEvents="none" style={[styles.shade, { left: 0, width: x(startAt) }]} />
            <View
              pointerEvents="none"
              style={[styles.shade, { left: x(finishAt) + HANDLE_W, right: 0 }]}
            />
            <View
              style={[styles.handle, styles.handleStart, { left: x(startAt) }, dragging === 'start' && styles.handleOn]}
              {...startPan.panHandlers}
            />
            <View
              style={[styles.handle, styles.handleEnd, { left: x(finishAt) }, dragging === 'finish' && styles.handleOn]}
              {...finishPan.panHandlers}
            />
          </View>

          {/* Each mark shows its own timestamp. At full-clip scale one frame is
              about 1.5pt of strip — invisible — so without a number a step button
              looks broken even when it worked. The big preview is the real
              feedback; this is the confirmation. */}
          <View style={styles.stepRow}>
            <StepGroup
              label="Start"
              at={startMark?.pts ?? startAt}
              onStep={(d) => void step('start', d)}
            />
            <StepGroup
              label="Finish"
              at={finishMark?.pts ?? finishAt}
              onStep={(d) => void step('finish', d)}
            />
          </View>

          <Text style={styles.facts}>
            {[
              measuredFps(grid) ? `${measuredFps(grid)!.toFixed(1)}fps measured` : null,
              isVariableRate(grid) ? 'variable frame rate' : null,
              formatBytes(clip.bytes),
              perf,
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>

          {/* The honest caveat, on screen rather than in a help page. Frame timing
              is the SMALL term; camera angle and which body part you judge are
              larger and are not measurable from the file. */}
          <Text style={styles.caveat}>
            Video timing is not gate-accurate. Beyond the ±{timing ? timing.quantSdMs.toFixed(0) : '—'}ms
            above, a camera that is not square to the finish line and the body part you judge add more
            — around {BODY_PART_BIAS_MS}ms for the latter. Video runs are charted separately from gate
            runs for that reason.
          </Text>

          {/* Attribution. A video run is not a different kind of record, so it
              carries the same two facts as any other. */}
          <Pressable style={styles.tagRow} onPress={() => setPickingAthlete(true)}>
            <Text style={styles.tagLabel}>Athlete</Text>
            <Text style={[styles.tagValue, !athlete && styles.tagEmpty]}>
              {athlete?.display_name ?? 'Unassigned'}
            </Text>
            <Text style={styles.tagHint}>{followingLineup ? 'from lineup' : 'chosen'}</Text>
          </Pressable>

          <Pressable style={styles.tagRow} onPress={() => setPickingDrill(true)}>
            <Text style={styles.tagLabel}>Drill</Text>
            <Text style={[styles.tagValue, !drill && styles.tagEmpty]}>
              {drill?.name ?? 'Pick a drill'}
            </Text>
          </Pressable>

          <View style={styles.saveRow}>
            <Pressable
              style={[styles.secondary, (!timing || !drill) && styles.disabled]}
              onPress={() => void save(false)}
              disabled={!timing || !drill}
            >
              <Text style={styles.secondaryText}>Keep time only</Text>
            </Pressable>
            <Pressable
              style={[styles.primary, styles.grow, (!timing || !drill) && styles.disabled]}
              onPress={() => void save(true)}
              disabled={!timing || !drill}
            >
              <Text style={styles.primaryText}>Keep both</Text>
            </Pressable>
          </View>

          <DrillPickerModal
            visible={pickingDrill}
            currentId={drill?.id ?? null}
            onClose={() => setPickingDrill(false)}
            onPick={(d) => {
              setDrill(d);
              setPickingDrill(false);
            }}
          />

          <AthletePickerModal
            visible={pickingAthlete}
            currentId={athleteId}
            title="Whose run is this?"
            onClose={() => setPickingAthlete(false)}
            onPick={(id) => {
              // Even picking the same athlete counts as a choice: it stops the
              // attribution drifting if the lineup cursor moves afterwards.
              setAthleteOverride(id);
              setPickingAthlete(false);
            }}
          />

          <Pressable style={styles.tertiary} onPress={pick}>
            <Text style={styles.tertiaryText}>Import a different clip</Text>
          </Pressable>
        </ScrollView>
      )}
    </View>
  );
}

function StepGroup({
  label,
  at,
  onStep,
}: {
  label: string;
  at: number;
  onStep: (delta: number) => void;
}) {
  return (
    <View style={styles.stepGroup}>
      <Pressable style={styles.stepBtn} onPress={() => onStep(-1)} hitSlop={8}>
        <Text style={styles.stepText}>‹</Text>
      </Pressable>
      <View style={styles.stepMid}>
        <Text style={styles.stepLabel}>{label}</Text>
        {/* Three decimals on purpose: this is a FRAME POSITION, not a measurement.
            The elapsed time above is the thing that has to respect its error bar. */}
        <Text style={styles.stepAt}>{at.toFixed(3)}s</Text>
      </View>
      <Pressable style={styles.stepBtn} onPress={() => onStep(1)} hitSlop={8}>
        <Text style={styles.stepText}>›</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0e1116', paddingTop: 52 },
  // flex: 1 so the video takes every point the controls do not. Marking a crossing
  // is a judgement about where a foot is relative to a cone; a fixed-height box
  // above scrollable content made that the smallest thing on screen.
  preview: {
    flex: 1,
    backgroundColor: '#000',
    marginHorizontal: 10,
    borderRadius: 12,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  video: { width: '100%', height: '100%' },
  placeholder: { color: '#475569', fontSize: 14 },
  busy: { position: 'absolute', alignItems: 'center', gap: 6 },
  busyText: { color: '#93c5fd', fontSize: 12 },
  // Overlaid bottom-left of the video: legible against footage without costing the
  // footage any height.
  readout: {
    position: 'absolute',
    left: 12,
    bottom: 10,
    backgroundColor: 'rgba(9,12,17,0.66)',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
    alignItems: 'flex-start',
  },
  elapsed: { color: '#fff', fontSize: 34, fontWeight: '800', fontVariant: ['tabular-nums'] },
  pm: { color: '#cbd5e1', fontSize: 11 },
  // Capped so a long clip's controls never grow into the preview; scrolls instead.
  controls: { maxHeight: 310, flexGrow: 0 },
  controlsBody: { padding: 10, paddingBottom: 28, gap: 10 },
  strip: {
    height: STRIP_H,
    flexDirection: 'row',
    backgroundColor: '#0b0e13',
    borderRadius: 8,
    overflow: 'hidden',
  },
  tile: { height: STRIP_H },
  shade: { position: 'absolute', top: 0, bottom: 0, backgroundColor: 'rgba(9,12,17,0.72)' },
  handle: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: HANDLE_W,
    backgroundColor: '#60a5fa',
    borderRadius: 4,
  },
  handleStart: { borderTopRightRadius: 0, borderBottomRightRadius: 0 },
  handleEnd: { borderTopLeftRadius: 0, borderBottomLeftRadius: 0 },
  handleOn: { backgroundColor: '#93c5fd' },
  stepRow: { flexDirection: 'row', gap: 10 },
  stepGroup: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#131a24',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  stepMid: { flex: 1, alignItems: 'center' },
  stepLabel: { color: '#94a3b8', fontSize: 11, fontWeight: '600' },
  stepAt: { color: '#e2e8f0', fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  stepBtn: {
    width: 44,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#243042',
    borderRadius: 8,
  },
  stepText: { color: '#e2e8f0', fontSize: 20, fontWeight: '700' },
  facts: { color: '#64748b', fontSize: 11, textAlign: 'center' },
  tagRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#131a24',
    borderRadius: 10,
    paddingHorizontal: 14,
    minHeight: 48,
    gap: 12,
  },
  tagLabel: { color: '#94a3b8', fontSize: 13, fontWeight: '600' },
  tagValue: { flex: 1, color: '#e2e8f0', fontSize: 15, fontWeight: '600', textAlign: 'right' },
  tagEmpty: { color: '#64748b', fontWeight: '400' },
  tagHint: { color: '#64748b', fontSize: 10, minWidth: 58, textAlign: 'right' },
  caveat: { color: '#64748b', fontSize: 11, lineHeight: 16 },
  saveRow: { flexDirection: 'row', gap: 10 },
  grow: { flex: 1 },
  primary: { backgroundColor: '#1d4ed8', borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  primaryText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  secondary: { backgroundColor: '#243042', borderRadius: 10, paddingVertical: 14, paddingHorizontal: 16, alignItems: 'center' },
  secondaryText: { color: '#cbd5e1', fontSize: 15, fontWeight: '600' },
  tertiary: { alignItems: 'center', paddingVertical: 10 },
  tertiaryText: { color: '#60a5fa', fontSize: 13, fontWeight: '600' },
  disabled: { opacity: 0.4 },
});
