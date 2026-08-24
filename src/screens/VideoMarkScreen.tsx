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
// Accuracy is STATED, not implied by rounding. Two decimals always, with the +/-
// from the two marked frames' measured durations printed beside them. An earlier
// version dropped the second decimal on a 30fps clip on the grounds that ~13.6ms
// of spread cannot support a 10ms digit — arithmetically right, practically worse:
// a tenth is too coarse to read, and rounding hides the uncertainty instead of
// saying it out loud.

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

import { AthletePickerModal } from '../components/AthletePicker';
import { DrillPickerModal } from '../components/DrillPicker';
import { VideoRecordModal, type Recorded } from './VideoRecordModal';
import { saveRun, type Drill } from '../db/database';
import { effectiveRunDate, isBackdated, sameLocalDay } from '../runs/rundate';
import { RunDateModal, confirmRunDate } from '../runs/RunDateEditor';
import { useRoster } from '../roster/RosterProvider';
import {
  deleteClip,
  importClip,
  NotEnoughSpaceError,
  PHOTO_ACCESS_MESSAGE,
  PHOTO_ACCESS_TITLE,
  pickVideo,
  type Clip,
} from '../video/clips';
import { acceptRecording } from '../video/capture';
import { describeClip } from '../video/storage';
import { filmstrip, probeGridAround, probeToResolve, waitForClip, type Tile } from '../video/frames';
import {
  acceptForTiming,
  BODY_PART_BIAS_MS,
  emptyGrid,
  formatVideoSeconds,
  formatVideoTime,
  isVariableRate,
  lastMarkableTime,
  markAt,
  measuredFps,
  nominalSdMs,
  seekTimeFor,
  stepFrames,
  timeFromMarks,
  videoRunRawJson,
  whyNotTimeable,
  VIDEO_MODE,
  type FrameGrid,
  type TimeScale,
  type VideoMark,
} from '../video/timing';
import {
  CAUTION,
  FAINT,
  INTERACTIVE,
  INTERACTIVE_SOFT,
} from '../theme';

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
/** Longest wait for a newly loaded clip to report a duration, in ms. Generous
 *  because the alternative is telling a coach their clip is unreadable when it
 *  was only slow; bounded because a source that never loads must not hang. */
const DURATION_TIMEOUT_MS = 8000;

type Which = 'start' | 'finish';

/**
 * Longest a single probe may take before the screen stops waiting for it, in ms.
 *
 * Generous — a settle on a cold decoder measured ~900ms at its worst — and it is a
 * DEADLOCK bound, not a performance one. Nothing here should ever reach it.
 */
const PROBE_TIMEOUT_MS = 6000;

/**
 * Race a probe against a deadline, and IGNORE a late answer rather than applying it.
 *
 * The late result is the part that matters. A probe that comes back after the screen
 * has given up carries a grid built from a position the coach has since left, and
 * writing it would move the mark under them. Dropping it is the only safe answer.
 *
 * This did not cause the SNAPPING lock — that probe returned in zero milliseconds,
 * having decided it had nothing to do. This is for the other failure: a decoder that
 * genuinely never answers, which nothing in this screen previously bounded.
 */
async function withDeadline<T>(p: Promise<T>, ms: number): Promise<{ ok: true; value: T } | { ok: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: false }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false }), ms);
  });
  try {
    return await Promise.race([p.then((value) => ({ ok: true as const, value })), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export default function VideoMarkScreen({
  isVisible = true,
  onSaved,
}: {
  /** False while this screen is mounted but hidden behind the library pane. The
   *  clip and both marks survive; the player is paused so it stops holding a
   *  decoder for a screen nobody is looking at. */
  isVisible?: boolean;
  onSaved?: (ms: number) => void;
}) {
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
  /** Which mark the step arrows drive. Start by default, so the arrows work the
   *  moment a clip lands rather than waiting for a handle to be touched. */
  const [active, setActive] = useState<Which>('start');
  /**
   * The clip's frame duration, as STATE rather than a memo.
   *
   * It was `useMemo(..., [clip, player])`, which evaluated on the render that set
   * the clip — before replaceAsync had resolved and before the tracks existed. So
   * player.videoTrack was null, it fell back to 30fps, and nothing ever
   * recomputed it: a 24fps clip was probed on a 30fps grid for its whole life.
   */
  const [frameDur, setFrameDur] = useState(1 / 30);
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
  /**
   * When the run HAPPENED. Seeded from the clip's own capture date, so the common
   * case — mark a clip filmed last September — needs no typing and cannot be
   * mistyped. Null means "now", which is what a clip filmed today resolves to.
   */
  const [performedAt, setPerformedAt] = useState<number | null>(null);
  const roster = useRoster();

  const athleteId = athleteOverride !== undefined ? athleteOverride : (roster.currentAthlete?.id ?? null);
  const athlete = roster.byId(athleteId);
  const followingLineup = athleteOverride === undefined;

  const player = useVideoPlayer(null, (p) => {
    p.muted = true;
    p.pause();
  });

  const duration = player.duration || 0;

  // Latest values for the pan responder, which is created once and would
  // otherwise close over the first render's state.
  // Everything an async handler needs to read, refreshed every render. State read
  // from a closure is whatever it was when that closure was created, which for a
  // handler that awaits is the value from BEFORE the await — the bug behind both
  // the compounding drag and the degrading step.
  const live = useRef({
    stripW: 0,
    duration: 0,
    startAt: 0,
    finishAt: 0,
    grid: emptyGrid(),
    active: 'start' as Which,
    frameDur: 1 / 30,
  });
  live.current = { stripW, duration, startAt, finishAt, grid, active, frameDur };
  /** The handle's position when the drag STARTED. See onPanResponderGrant. */
  const dragBase = useRef(0);
  /** Live-scrub bookkeeping: throttle state plus what the seeks actually cost, so
   *  "is a seek per drag event affordable" is answered with a number. */
  const dragSeeks = useRef({ n: 0, ms: 0, lastAt: 0, lastT: -1 });
  /** What each interaction actually cost, shown on screen so "it feels slow" can
   *  be answered with a number instead of a guess. */
  const [perf, setPerf] = useState<string | null>(null);

  useEffect(() => {
    if (!isVisible) player.pause();
  }, [isVisible, player]);

  // ------------------------------------------------ getting a clip in

  /**
   * True while a clip is being loaded, from either source.
   *
   * A ref rather than reading `busy`, because a handler reads state from the
   * closure it was made in. Two clips racing is not a cosmetic problem: the
   * second replaces the player's source while the first is still probing, and the
   * probe writes ITS frames into `live.current.grid`, which the second clip's
   * marks are then resolved against. The recorded time would be computed from
   * another video's frame timestamps.
   *
   * It covers recording as well as importing now, and it has to: the two buttons
   * sit beside each other, and a recording arriving while an import is still
   * probing is the same collision by a different route.
   */
  const loadingClip = useRef(false);

  /**
   * Why this clip's TIME is refused, or null.
   *
   * LAYER 3, and this screen is the only place it can live. capture.ts checks what
   * the device claims and what the session resolved to, both before recording and
   * neither able to see a frame — and the frames are the only evidence. They exist
   * here, after the grid is probed, which is a minute after the camera screen has
   * gone. That is why a recording carries its two claimed rates along with it: so
   * they can be settled against the file, here, by the thing that overrules them.
   *
   * The clip is KEPT when this is set. What is refused is the time, not the footage.
   */
  const [refused, setRefused] = useState<string | null>(null);

  /** Back to an empty screen. Shared by the save path and by clearing a clip whose
   *  time was refused, so the two cannot drift into forgetting different things. */
  const reset = useCallback(() => {
    setClip(null);
    setTiles([]);
    setGrid(emptyGrid());
    setPerformedAt(null);
    setRefused(null);
  }, []);

  /**
   * Put a clip on the screen: source, duration, frame grid, two marks.
   *
   * Shared by both ways in, and the reason recording cost so little to add — the
   * filmstrip, the handles, the stepping and the save path never learn where a clip
   * came from. `capture` is present only for a recording, and only so layer 3 can
   * run: an imported clip has no requested rate to hold the file against.
   */
  const loadClip = useCallback(
    async (
      c: Clip,
      capture?: { requestedFps: number; selectedFps: number | null; timeScale: TimeScale },
    ) => {
      setClip(c);
      setGrid(emptyGrid());
      setTiles([]);
      setRefused(null);
      await player.replaceAsync(c.uri);
      setBusy('Reading the clip…');
      // WAIT for the tracks, do not assume a duration.
      //
      // This was a flat 400ms sleep, which is a bet on how fast the device is. Lose
      // that bet — a long clip, a cold decoder, a busy phone — and duration comes
      // back 0, so the end mark lands at 0, the filmstrip effect is gated on
      // `duration` and never fires, and Keep stays disabled. Nothing re-reads
      // duration afterwards, because it is a property of a mutable player object
      // that React has no reason to re-render for, so the screen stays dead until
      // the clip is loaded again.
      // BOTH facts, not just the length. See waitForClip: duration arrives first,
      // and reading the frame rate before the track exists silently seeds every
      // probe on this clip at 30fps.
      const { durationSec: d, frameDurSec: dur, tracked } = await waitForClip(player, DURATION_TIMEOUT_MS);
      setFrameDur(dur);
      setActive('start');
      if (!d) {
        // Said plainly rather than left as an empty strip. Everything else here
        // would go on to compute marks from a duration that does not exist.
        Alert.alert(
          'Could not read that clip',
          'The video is stored but its length could not be read, so it cannot be marked. It is in Videos if you want to try again.',
        );
        return;
      }

      // Marks land on REAL frames, and the grid around them is probed now rather
      // than on first use. Two bugs lived here: finishAt was set to `duration`
      // exactly, which is past the last frame — extraction has nothing to return
      // there, so the anchor failed, the grid stayed empty and the Finish arrows
      // silently did nothing. And with no grid at all, neither arrow could resolve
      // a frame until a handle had been dragged.
      const endAt = lastMarkableTime(d, dur);
      let g = emptyGrid();
      g = (await probeGridAround(player, g, 0, dur)).grid;
      g = (await probeGridAround(player, g, endAt, dur)).grid;
      setGrid(g);
      setStartAt(markAt(g, 0)?.pts ?? 0);
      setFinishAt(markAt(g, endAt)?.pts ?? endAt);
      player.currentTime = dur / 2;

      // LAYER 3, against the frames that were just probed rather than against
      // anything the camera said about itself. A session can report 240 and hold it,
      // and it can report 240 and write 30; only this tells them apart, and a time
      // taken from the second would be eight times too fast, charted as a personal
      // best, and indistinguishable afterwards from a real one.
      if (capture) {
        // THE SAME TIMESCALE GATE THE IMPORT PATH RUNS, on the value a recording
        // carries. It accepts silently, which is the whole point: 'recorded' is not
        // 'unknown', and routing the recording through the gate is what keeps that
        // true rather than merely true today.
        const scale = acceptForTiming(capture.timeScale);
        if (!scale.accept) {
          setRefused(scale.reason);
          Alert.alert('This clip cannot be timed', scale.reason);
          return;
        }
        if (scale.warn) Alert.alert('Check this clip', scale.warn);

        // A MEASUREMENT ON A GUESSED GRID IS NOT EVIDENCE. If the frame rate never
        // became readable, the probe aimed at 30fps centres and can only report a
        // submultiple — so measuredFps would be measuring the guess, and layer 3
        // would refuse a good recording and blame the camera. Passing null instead
        // makes acceptRecording say what is actually true: the file could not be
        // read back, so no time can be taken from it, and the video is kept.
        const measured = tracked ? measuredFps(g) : null;
        const v = acceptRecording(capture.requestedFps, capture.selectedFps, measured);
        if (!v.ok) {
          setRefused(v.reason);
          Alert.alert('This recording cannot be timed', v.reason);
        }
      }
    },
    [player],
  );

  const pick = useCallback(async () => {
    if (loadingClip.current) return;
    loadingClip.current = true;
    setBusy('Importing…');
    try {
      // The picker's options live in clips.ts, not here. Two of them are what stop
      // PHPhotosError 3164 and a silent re-encode, and they were previously a
      // verbatim copy in the attach path with the reasoning only in this one.
      const picked = await pickVideo();
      if (picked.status === 'denied') {
        Alert.alert(PHOTO_ACCESS_TITLE, PHOTO_ACCESS_MESSAGE);
        return;
      }
      if (picked.status !== 'picked') return;

      // REFUSED BEFORE THE COPY, not after. A clip that can never be timed should
      // not first cost tens of megabytes and a filmstrip build, and it should not
      // land in the library for the coach to wonder about later.
      //
      // The import path's equivalent of the session check a recording gets before
      // the rep is run: in both cases this is the last moment refusing is free.
      const verdict = acceptForTiming(picked.timeScale);
      if (!verdict.accept) {
        Alert.alert('This clip cannot be timed', verdict.reason);
        return;
      }

      // Derived, not typed. A date read off the footage is right by construction;
      // the editor below exists for the cases where it is absent or wrong.
      setPerformedAt(picked.capturedAt);
      const imported = await importClip(picked.uri);
      // A warning, not a gate. Shown after the import so it does not sit between
      // the coach and a clip that is probably fine.
      if (verdict.warn) Alert.alert('Check this clip', verdict.warn);
      await loadClip(imported);
    } catch (e) {
      // NotEnoughSpaceError already reads as a sentence; anything else does not,
      // so it keeps its own title rather than being flattened into one message.
      Alert.alert(
        e instanceof NotEnoughSpaceError ? 'Not enough space' : 'Could not import that clip',
        e instanceof NotEnoughSpaceError ? e.message : String(e),
      );
    } finally {
      loadingClip.current = false;
      setBusy(null);
    }
  }, [loadClip]);

  /** Whether the camera sheet is UP. Not whether it is recording — the sheet owns
   *  that, and conflating the two is how a Stop button ends up wired to a Cancel. */
  const [recordOpen, setRecordOpen] = useState(false);

  /**
   * A rep filmed in the app, arriving exactly where an imported one does.
   *
   * The clip is already written and already in Videos by the time this runs — the
   * recorder wrote straight into the clip directory — so there is nothing to copy
   * and nothing to lose if this screen happens to be busy. Which is what lets the
   * collision case below say something true instead of dropping a rep.
   */
  const onRecorded = useCallback(
    async (r: Recorded) => {
      setRecordOpen(false);
      if (loadingClip.current) {
        Alert.alert(
          'One clip at a time',
          'Another clip is still loading, so this recording was not opened. It is saved in ' +
            'Videos and can be attached to a run from there.',
        );
        return;
      }
      loadingClip.current = true;
      setBusy('Reading the recording…');
      try {
        // Filmed now. Nothing to derive from a photo library and nothing to
        // backdate — see isBackdated, which compares local days for this reason.
        setPerformedAt(null);
        if (r.note) Alert.alert('Recording finished', r.note);
        await loadClip(r.clip, {
          requestedFps: r.requestedFps,
          selectedFps: r.selectedFps,
          timeScale: r.timeScale,
        });
      } catch (e) {
        Alert.alert('Could not read that recording', String(e));
      } finally {
        loadingClip.current = false;
        setBusy(null);
      }
    },
    [loadClip],
  );

  /**
   * Let go of a clip whose time was refused.
   *
   * It needs an exit, and the exit is a QUESTION rather than a delete. Layer 3
   * refuses the time; it says nothing about the footage, which is often still worth
   * watching — a rep filmed at the wrong rate is still a rep. So the choice is the
   * coach's, and both answers clear the screen.
   */
  const clearClip = useCallback(() => {
    const c = clip;
    if (!c) return;
    Alert.alert(
      'Keep the video?',
      'Its time was refused, but the footage itself is fine to watch and is already in Videos.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Keep it', onPress: reset },
        {
          text: 'Delete it',
          style: 'destructive',
          onPress: () => {
            deleteClip(c.id);
            reset();
          },
        },
      ],
    );
  }, [clip, reset]);

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
  /**
   * Set when a settle failed rather than merely found nothing.
   *
   * Distinct from whyNotTimeable, which describes the STATE of the marks. This
   * describes the last ATTEMPT, and the two want different words: "the finish mark
   * is not on a readable frame" tells the coach to move it, "the clip stopped
   * responding" tells them it is not their fault.
   */
  const [settleNote, setSettleNote] = useState<string | null>(null);
  /**
   * True while a settle is in flight.
   *
   * The screen has to be able to say "not resolved YET" apart from "cannot be
   * resolved", and without this it could not: whyNotTimeable reads the marks, the
   * marks are recomputed on every drag frame, and the grid is not probed until the
   * finger lifts. So the honest message fired continuously during every ordinary
   * drag and told the coach to fix something that was about to fix itself.
   */
  const [settling, setSettling] = useState(false);

  const settleAt = useCallback(
    async (seconds: number) => {
      if (!clip) return;
      setSettling(true);
      try {
        // From the ref, not the closure: a drag can release while a previous settle
        // is still resolving, and the closure's grid would be the pre-drag one.
        //
        // BOUNDED. Nothing here used to be, so a probe that never came back left the
        // readout on SNAPPING with no way out but reloading the clip — and no way to
        // tell that from a mark that simply had not resolved.
        // probeToResolve, not probeGridAround: if the mark lands on the last frame
        // of its window it has no measured successor, and the answer is to go and
        // measure one rather than to ask the coach to nudge the handle. See the note
        // there on why this widens instead of snapping.
        const out = await withDeadline(
          probeToResolve(player, live.current.grid, seconds, live.current.frameDur),
          PROBE_TIMEOUT_MS,
        );
        if (!out.ok) {
          setSettleNote(
            'Reading that part of the clip took too long and was given up on. Move the handle ' +
              'again to retry.',
          );
          setPerf(`settle timed out after ${PROBE_TIMEOUT_MS}ms`);
          return;
        }
        const r = out.value;
        setGrid(r.grid);
        live.current.grid = r.grid;
        const m = markAt(r.grid, seconds);
        const t0 = Date.now();
        // Seek to the frame's MIDDLE — a request on a boundary is decided by float
        // representation and can show the frame before.
        player.currentTime = m ? seekTimeFor(m) : seconds;
        const d = dragSeeks.current;
        setSettleNote(null);
        // "ISSUED", not "seek". Assigning currentTime hands a request to
        // AVFoundation and returns; the frame arrives later. Timing the assignment
        // measures the setter, not the seek, and this line called it "seek Xms" for
        // months — a number that looked like decode cost and was not. Measuring the
        // real thing means polling for the readback, which costs more than the
        // figure is worth, so it is labelled honestly instead of measured badly.
        setPerf(
          `probe ${r.ms}ms/${r.calls}${r.resolved ? '' : ' · UNRESOLVED'} · seek issued ${Date.now() - t0}ms` +
            (d.n ? ` · drag ${d.n} seeks, ${(d.ms / d.n).toFixed(1)}ms each` : ''),
        );
      } catch (e) {
        // SAID, NOT SWALLOWED. This had no catch at all, so a throwing probe became
        // an unhandled rejection: the grid stayed as it was, the readout stayed on
        // SNAPPING, and nothing on screen or in the log recorded that anything had
        // gone wrong.
        setSettleNote(`Could not read that part of the clip: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setSettling(false);
      }
    },
    [clip, player],
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

  /**
   * Why Keep is unavailable, or null when it is not.
   *
   * ORDERED BY WHOSE PROBLEM IT IS. A refused time is the app's verdict and outranks
   * everything; a failed settle is the clip misbehaving; an unresolved mark is a
   * position the coach can fix by moving a handle. Keep used to be gated on `timing`
   * alone and said none of this — it simply did not respond, which is what sent two
   * diagnoses down the wrong path before the real one was reproduced offline.
   */
  const keepBlocked = useMemo(
    () =>
      refused ??
      settleNote ??
      // "NOT YET" IS NOT "CANNOT". A mark under a moving finger, or one whose settle
      // has not landed, is mid-resolution — and whyNotTimeable describes a state, so
      // it cannot tell those from a dead end. Suppressing it here is what makes the
      // message mean something when it does appear: by then the probe has run,
      // widened once past the window edge, and still failed.
      //
      // refused and settleNote are NOT suppressed. A layer 3 refusal is a verdict
      // that survives any amount of dragging, and a timed-out settle is a fact about
      // the last attempt rather than about the marks.
      (dragging || settling
        ? null
        : whyNotTimeable({
            frameCount: grid.frames.length,
            startResolved: !!startMark,
            finishResolved: !!finishMark,
          })),
    [refused, settleNote, dragging, settling, grid.frames.length, startMark, finishMark],
  );

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
        // Touching a handle also makes it the one the arrows drive — otherwise the
        // coach drags one mark and then nudges the other.
        setActive(which);
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
        // NOT Math.min(d, …). The last frame of a clip has no measured successor,
        // so its duration is unknown and markAt/stepFrames both refuse it — by
        // design, because an error bar computed from a frame length nobody
        // measured would be a fabrication. Landing a handle exactly on `d` therefore
        // resolved to no frame at all, and the mark could not be stepped in either
        // direction or dragged any further right: permanently stuck.
        //
        // This is the same trap the import path already avoids with
        // `endAt = d - dur * 1.5`; the drag never got the same treatment. It went
        // unnoticed on ordinary clips because slamming into the right edge is
        // something you do by accident, and it surfaced on a slow-motion clip
        // because the stretched duration makes the drag many times more sensitive
        // in seconds per point — you hit the edge without meaning to.
        next = Math.max(0, Math.min(lastMarkableTime(d, frameDur), next));
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

  /**
   * Frame stepping, serialised and coalesced.
   *
   * Presses used to each start their own async probe. Because they all captured
   * the grid from before the first await, none of them saw the frames the others
   * had found, so every one paid a full re-probe — and N rapid presses put N times
   * seventeen extraction calls in flight at once, which is why it got WORSE the
   * more it was pressed rather than merely slow. They also all computed from the
   * same stale mark, so three presses could advance one frame.
   *
   * Now a press only adds to a counter. One worker drains it, reading current
   * state from the live ref, and applies whatever has accumulated in a single
   * probe and a single seek — so holding the button is one round trip, not twenty.
   */
  const stepQueue = useRef(0);
  const stepping = useRef(false);

  const drainSteps = useCallback(async () => {
    if (stepping.current) return;
    stepping.current = true;
    try {
      while (stepQueue.current !== 0) {
        const delta = stepQueue.current;
        stepQueue.current = 0;

        const { active: which, startAt: s, finishAt: f, grid: g, frameDur: fd } = live.current;
        const at = which === 'start' ? s : f;
        // Bounded for the same reason as settleAt, and it matters more here: this
        // loop holds `stepping.current`, so a probe that never returns would leave
        // the arrows dead for the life of the screen as well as the readout stuck.
        const out = await withDeadline(probeGridAround(player, g, at, fd), PROBE_TIMEOUT_MS);
        if (!out.ok) {
          setPerf(`step ${delta > 0 ? '+' : ''}${delta} · timed out after ${PROBE_TIMEOUT_MS}ms`);
          continue;
        }
        const r = out.value;
        if (r.calls) setGrid(r.grid);

        const m = stepFrames(r.grid, at, delta);
        if (!m) {
          // Said, not swallowed. "The arrows do nothing" has been the symptom of
          // three different bugs on this screen, and each time the first question
          // was whether the press arrived at all. It reaches here when the probe
          // came back empty — the end of the clip, or a decoder that was asleep
          // because the app was in the background.
          setPerf(`step ${delta > 0 ? '+' : ''}${delta} · no frame there · probe ${r.ms}ms/${r.calls}`);
          continue;
        }
        // The handles cannot cross by stepping either, not just by dragging.
        if (which === 'start') {
          if (m.pts >= live.current.finishAt) continue;
          setStartAt(m.pts);
          live.current.startAt = m.pts;
        } else {
          if (m.pts <= live.current.startAt) continue;
          setFinishAt(m.pts);
          live.current.finishAt = m.pts;
        }
        // Written back to the ref as well as to state: the next lap of this loop
        // runs before React has re-rendered, and would otherwise step from the
        // position we just left.
        live.current.grid = r.grid;

        const t0 = Date.now();
        player.currentTime = seekTimeFor(m);
        // See settleAt: this times the assignment returning, not the seek landing.
        setPerf(`step ${delta > 0 ? '+' : ''}${delta} · probe ${r.ms}ms/${r.calls} · seek issued ${Date.now() - t0}ms`);
      }
    } finally {
      stepping.current = false;
    }
  }, [player]);

  const step = useCallback(
    (delta: number) => {
      stepQueue.current += delta;
      void drainSteps();
    },
    [drainSteps],
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
    async () => {
      if (!timing || !clip || !startMark || !finishMark) return;
      setBusy('Saving…');
      try {
        await saveRun({
          mode: VIDEO_MODE,
          totalMs: Math.round(timing.elapsedMs),
          split1Ms: 0,
          split2Ms: 0,
          athleteId,
          // Optional, exactly as for any other run. An unlabelled run is a valid
          // state — it simply does not reach the charts until a drill is assigned,
          // which History can already do.
          drillType: drill?.name ?? null,
          rawJson: videoRunRawJson({
            startPts: startMark.pts,
            endPts: finishMark.pts,
            // MEASURED, not the track's nominal figure — a clip reporting 25.5fps
            // is telling you it is variable, and the row should record what was
            // actually observed between the marks.
            fps: measuredFps(grid) ?? 1 / frameDur,
            quantSdMs: timing.quantSdMs,
          }),
          // The clip is a COLUMN, not part of raw_json. raw_json says how the run
          // was timed; clip_id says whether there is footage. Keeping them apart is
          // what lets a gate run carry review video without being reclassified.
          clipId: clip.id,
          // NULL unless the footage says otherwise. A run marked from a clip
          // filmed today is not backdated and must not be flagged as though it
          // were — see isBackdated, which compares local days for that reason.
          performedAt: performedAt && !sameLocalDay(performedAt, Date.now()) ? performedAt : null,
        });
        // Advance the lineup ONLY when this run belongs to whoever is up. Marking
        // an old clip for someone three places back must not move the cursor —
        // that would skip a live athlete's turn on the strength of a desk job.
        if (athleteId && athleteId === roster.currentAthlete?.id) roster.completeRun();
        onSaved?.(timing.elapsedMs);
        Alert.alert(
          'Time recorded',
          `${formatVideoTime(timing)}${drill ? ` · ${drill.name}` : ''}\n\n` +
            (drill ? 'Video kept with the run.' : 'No drill yet — assign one in History to chart it.'),
        );
        reset();
      } catch (e) {
        Alert.alert('Could not save', String(e));
      } finally {
        setBusy(null);
      }
    },
    // athleteId, not just roster: it is derived from athleteOverride too, and
    // leaving it out would let a stale closure attribute the run to whoever was
    // selected before the coach changed it.
    [timing, clip, startMark, finishMark, grid, frameDur, drill, athleteId, performedAt, roster, onSaved, reset],
  );

  /**
   * Set the date, after showing what it will DO.
   *
   * The rule itself lives in RunDateEditor, because the athlete run list asks the
   * same question about an already-saved run and the two must not drift. What is
   * local to this screen is only WHICH run is being dated: one that does not exist
   * yet, timed from this clip.
   */
  const [pickingDate, setPickingDate] = useState(false);

  const confirmDate = useCallback(
    async (at: number) => {
      await confirmRunDate({
        at,
        athleteId,
        drill: drill ? { id: drill.id, name: drill.name } : null,
        elapsedMs: timing?.elapsedMs ?? 0,
        // A run marked on this screen is video-timed by construction.
        timeSource: 'video',
        onConfirm: setPerformedAt,
      });
    },
    [athleteId, drill, timing],
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
            <Text style={styles.elapsed}>{formatVideoSeconds(liveMs)}s</Text>
            {/* The ± is what licenses the second decimal, and it is ALWAYS a ±.
                It used to be replaced by the words "release to snap to frames"
                whenever the marks were not yet resolved, so the line under the
                number you are reading swapped between a figure and a sentence on
                every drag — a flicker exactly where the eye is.

                The precision STATE now has its own slot to the right, at a fixed
                width, so it changes without moving or replacing anything else. And
                the provisional ± is not a placeholder: nominalSdMs is the same
                arithmetic timeFromMarks uses for two frames of equal length, so
                the number only tightens when the real frame durations arrive. */}
            <View style={styles.pmRow}>
              <Text style={styles.pm}>
                ± {Math.round(timing ? timing.quantSdMs : nominalSdMs(frameDur))}ms frame timing
              </Text>
              <Text style={[styles.snap, timing ? styles.snapOn : styles.snapOff]}>
                {timing ? 'ON FRAME' : 'SNAPPING'}
              </Text>
            </View>
          </View>
        ) : null}
      </View>

      {!clip ? (
        <View style={styles.controls}>
          {/* RECORD IS THE PRIMARY ONE, and that is an argument rather than a
              layout. A rep filmed here is filmed at a rate the app asked for and
              can check three ways; an imported clip arrives with whatever rate the
              Camera app chose, possibly slowed by iOS without saying so, and the
              most the app can do is refuse it afterwards. Import stays because a
              clip filmed last September is a real thing to want to mark. */}
          <Pressable style={styles.primary} onPress={() => setRecordOpen(true)}>
            <Text style={styles.primaryText}>Record a rep</Text>
          </Pressable>
          <Pressable style={styles.secondary} onPress={pick}>
            <Text style={styles.secondaryText}>Import a clip</Text>
          </Pressable>
          <Text style={styles.emptyNote}>
            Filming here records at a chosen frame rate and checks the file afterwards. Importing
            works from any clip you already have, at whatever rate it was filmed.
          </Text>
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
            <Pressable
              style={[styles.markBtn, active === 'start' && styles.markBtnOn]}
              onPress={() => setActive('start')}
            >
              <Text style={styles.markLabel}>Start</Text>
              <Text style={styles.markAt}>{(startMark?.pts ?? startAt).toFixed(3)}s</Text>
            </Pressable>
            <Pressable
              style={[styles.markBtn, active === 'finish' && styles.markBtnOn]}
              onPress={() => setActive('finish')}
            >
              <Text style={styles.markLabel}>Finish</Text>
              <Text style={styles.markAt}>{(finishMark?.pts ?? finishAt).toFixed(3)}s</Text>
            </Pressable>
          </View>

          {/* One pair of arrows driving whichever mark is selected, rather than a
              pair each. Two sets of arrows invited stepping the wrong one, and the
              screen has to stay readable with a thumb over half of it. */}
          <View style={styles.stepRow}>
            <Pressable style={styles.stepBtn} onPress={() => step(-1)} hitSlop={8}>
              <Text style={styles.stepText}>‹ frame</Text>
            </Pressable>
            <Pressable style={styles.stepBtn} onPress={() => step(1)} hitSlop={8}>
              <Text style={styles.stepText}>frame ›</Text>
            </Pressable>
          </View>

          <Text style={styles.facts}>
            {[
              measuredFps(grid) ? `${measuredFps(grid)!.toFixed(1)}fps measured` : null,
              isVariableRate(grid) ? 'variable frame rate' : null,
              // MEASURED, both halves: bytes off the file, seconds off the player.
              // There is no per-minute figure here and there is not going to be one
              // — see storage.ts, and the structural guard in verify-storage that
              // fails if one ever appears in src/.
              describeClip(clip.bytes, duration),
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
            — around {BODY_PART_BIAS_MS}ms for the latter, in one direction rather than either. Video
            runs share a chart with gate runs and are marked on it, so that difference stays visible
            without splitting the drill in two.
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

          {/* Seeded from the footage, so this normally needs no attention at all.
              The hint says WHERE the date came from, because "3 Sept" means one
              thing if the clip says so and another if the app assumed today. */}
          <Pressable style={styles.tagRow} onPress={() => setPickingDate(true)}>
            <Text style={styles.tagLabel}>Filmed</Text>
            <Text style={styles.tagValue}>
              {new Date(effectiveRunDate(performedAt, Date.now())).toLocaleDateString(undefined, {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}
            </Text>
            <Text style={styles.tagHint}>
              {performedAt === null
                ? 'today'
                : isBackdated(performedAt, Date.now())
                  ? 'backdated'
                  : 'from clip'}
            </Text>
          </Pressable>

          {/* WHY KEEP IS OFF, always, whatever the reason. Layer 3 refusing the
              time is one case and it gets the Clear action, because that clip is
              finished with. The others are recoverable and must not offer it. */}
          {keepBlocked ? (
            <View style={styles.refusalBox}>
              <Text style={styles.refusalText}>{keepBlocked}</Text>
              {refused ? (
                <Pressable style={styles.secondary} onPress={clearClip}>
                  <Text style={styles.secondaryText}>Clear this clip</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}

          <Pressable
            style={[styles.primary, (!timing || !!keepBlocked) && styles.disabled]}
            onPress={() => void save()}
            disabled={!timing || !!keepBlocked}
          >
            <Text style={styles.primaryText}>Keep</Text>
          </Pressable>

          {/* The wheel. Mounted here with the other pickers so a date edit behaves
              like every other attribution change on this screen. */}
          <RunDateModal
            visible={pickingDate}
            value={effectiveRunDate(performedAt, Date.now())}
            title="When was this filmed?"
            onCancel={() => setPickingDate(false)}
            onPick={(at) => {
              setPickingDate(false);
              void confirmDate(at);
            }}
          />

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

          <View style={styles.swapRow}>
            <Pressable style={styles.tertiary} onPress={() => setRecordOpen(true)}>
              <Text style={styles.tertiaryText}>Record another rep</Text>
            </Pressable>
            <Pressable style={styles.tertiary} onPress={pick}>
              <Text style={styles.tertiaryText}>Import a different clip</Text>
            </Pressable>
          </View>
        </ScrollView>
      )}

      {/* OUTSIDE the clip conditional, deliberately. Opened from the empty state,
          it would unmount the instant a recording lands and setClip flips the
          branch — taking the sheet down mid-dismissal. Here it closes because it
          was told to. */}
      <VideoRecordModal
        visible={recordOpen}
        onCancel={() => setRecordOpen(false)}
        onRecorded={(r) => void onRecorded(r)}
      />
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
  busyText: { color: INTERACTIVE_SOFT, fontSize: 12 },
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
  pmRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pm: { color: '#cbd5e1', fontSize: 11, fontVariant: ['tabular-nums'] },
  /** Fixed width so the state changing never reflows the ± beside it — the whole
   *  point of moving it out of that line. */
  snap: { fontSize: 9, fontWeight: '800', letterSpacing: 0.5, minWidth: 58, textAlign: 'right' },
  snapOn: { color: INTERACTIVE },
  snapOff: { color: FAINT },
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
    backgroundColor: INTERACTIVE,
    borderRadius: 4,
  },
  handleStart: { borderTopRightRadius: 0, borderBottomRightRadius: 0 },
  handleEnd: { borderTopLeftRadius: 0, borderBottomLeftRadius: 0 },
  handleOn: { backgroundColor: INTERACTIVE_SOFT },
  stepRow: { flexDirection: 'row', gap: 10 },
  markBtn: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: '#131a24',
    borderRadius: 10,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  markBtnOn: { borderColor: INTERACTIVE, backgroundColor: '#16202c' },
  markLabel: { color: '#94a3b8', fontSize: 11, fontWeight: '600' },
  markAt: { color: '#e2e8f0', fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
  stepBtn: {
    flex: 1,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#243042',
    borderRadius: 10,
  },
  stepText: { color: '#e2e8f0', fontSize: 16, fontWeight: '700' },
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
  primary: { backgroundColor: '#1d4ed8', borderRadius: 10, paddingVertical: 14, alignItems: 'center' },
  primaryText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  secondary: {
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#243042',
    backgroundColor: '#0b0e13',
  },
  secondaryText: { color: '#cbd5e1', fontSize: 15, fontWeight: '700' },
  emptyNote: { color: '#64748b', fontSize: 11.5, lineHeight: 16, textAlign: 'center' },
  // CAUTION, not DESTRUCTIVE: nothing has been destroyed. A refused time is a
  // measurement you should not rely on, which is exactly the one job that colour has.
  refusalBox: {
    gap: 10,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#3a2a17',
    backgroundColor: '#1a1409',
  },
  refusalText: { color: CAUTION, fontSize: 12.5, lineHeight: 18 },
  swapRow: { flexDirection: 'row', justifyContent: 'space-between' },
  tertiary: { alignItems: 'center', paddingVertical: 10 },
  tertiaryText: { color: INTERACTIVE, fontSize: 13, fontWeight: '600' },
  disabled: { opacity: 0.4 },
});
