// Main v1 screen. Arms modes, runs a local live timer for the live feel on
// START/GO, snaps to the gate's authoritative time on FINISH, plays the
// start-sequence audio cues, and persists each finished run to SQLite.
//
// Robustness: BLE notifications can be dropped/late, so we also reconcile the
// local run state against the gate's authoritative state (from STATE events,
// Status notifications, AND a Status poll while a run is in progress). A finish
// is recovered from the readable LastResult characteristic if the FINISH
// notification never arrives, so the result always displays and saves.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { setAudioModeAsync, useAudioPlayer, type AudioPlayer } from 'expo-audio';

import { useGate } from '../ble/GateProvider';
import { useSettings } from '../settings/SettingsProvider';
import { Evt, GateState, STATE_NAME } from '../ble/constants';
import type { LastResult } from '../ble/events';
import {
  addRecentAthlete,
  getRecentAthletes,
  getSetting,
  saveRun,
  setSetting,
} from '../db/database';
import { TagPickerModal, formatTags } from '../components/TagPicker';

const KEEP_AWAKE_TAG = 'equalsplit-run';
const nowMs = () =>
  typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now();

// Acoustic output latency: the gap between the player's playback position
// advancing (what playbackStatusUpdate.currentTime reports) and sound actually
// leaving the speaker. iOS exposes this as AVAudioSession.outputLatency, but
// expo-audio does not surface it — so we ASSUME a constant and carry its
// uncertainty as the main UNMEASURABLE residual. ~20ms is a typical built-in-
// speaker output latency for a non-low-latency AVAudioPlayer path.
const ACOUSTIC_OUTPUT_MS = 20; // best-estimate, added to the correction
const ACOUSTIC_UNCERTAINTY_MS = 15; // ± residual on the above (cannot be measured here)
const AUDIO_MEAS_NOISE_MS = 5; // residual audio-start noise after currentTime back-calc

// Physical-plausibility floor for a corrected Mode 2 reaction. A human cannot
// react to a stimulus faster than ~0.1s; sprint-start convention treats <0.15s
// as effectively impossible. A corrected reaction below this means the per-run
// correction subtracted MORE than the real beep latency — i.e. it over-corrected
// — so the value is a measurement artefact, not a real time. Flag, don't show.
const REACTION_FLOOR_MS = 150;
const fmtN = (v: number | null) => (v == null ? 'n/a' : v.toFixed(1));

type RunState = 'idle' | 'countdown' | 'running' | 'finished';
type Result = { mode: number; totalMs: number; split1Ms: number; split2Ms: number; flags: number };

const fmt = (ms: number, dec: number) => (Math.max(0, ms) / 1000).toFixed(dec);
const toResult = (lr: LastResult): Result => ({
  mode: lr.mode,
  totalMs: lr.totalMs,
  split1Ms: lr.split1Ms,
  split2Ms: lr.split2Ms,
  flags: lr.flags,
});

export default function TimerScreen() {
  const gate = useGate();
  const { subscribe, gateStatus, status, readStatusNow, readLastResultNow, gateToPhoneMs } = gate;
  const { reactionOffsetMs, setMeasuredAudioLatencyMs, correctionMode, addLatencySample, devMode } =
    useSettings();

  const marks = useAudioPlayer(require('../../assets/sounds/marks.wav'));
  const set = useAudioPlayer(require('../../assets/sounds/set.wav'));
  // Small update interval so we learn of playback start quickly; precision comes
  // from back-calculating start = callbackTime - currentTime, not the interval.
  const go = useAudioPlayer(require('../../assets/sounds/go.wav'), { updateInterval: 10 });

  const [runState, setRunState] = useState<RunState>('idle');
  const [phaseLabel, setPhaseLabel] = useState('');
  const [liveMs, setLiveMs] = useState(0);
  const [liveSplit1Ms, setLiveSplit1Ms] = useState<number | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [gateState, setGateState] = useState<GateState | null>(null);
  const [dbg, setDbg] = useState('');
  // Optional run tags. The current athlete/drill PERSIST across runs (until
  // changed/cleared) so timing several runs needs no re-selecting; they're saved
  // to settings so they also survive an app restart. finishedTags freezes what was
  // attached to the just-finished run for the result display.
  const [athlete, setAthlete] = useState('');
  const [drill, setDrill] = useState('');
  const [recents, setRecents] = useState<string[]>([]);
  const [tagOpen, setTagOpen] = useState(false);
  const [finishedTags, setFinishedTags] = useState<{ name: string; drill: string } | null>(null);
  // Correction actually applied to the shown result (per run).
  const [corr, setCorr] = useState<{
    correction: number; // ms subtracted from raw split1 (and total)
    source: 'synced' | 'fixed';
    beepEngine: number | null; // gate GO -> engine audio start (measured), pre-acoustic
    early: boolean; // raw split1 < correction (clamped, suspect)
    implausible: boolean; // corrected reaction below the human floor (over-corrected)
    confMs: number; // ±X confidence on the corrected reaction (synced only)
  } | null>(null);

  const t0Ref = useRef(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const finishedRef = useRef(false);
  const activeRef = useRef(false);
  const goPreSeekedRef = useRef(false);
  const primingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Per-run latency measurement (clock-synced where possible).
  type RunMeasure = {
    tRecv: number;
    t0us: number;
    tGoPhone: number | null;
    tPlay: number;
    tAudioStart: number | null;
  };
  const runMeasureRef = useRef<RunMeasure | null>(null);
  const runBeepLatencyRef = useRef<number | null>(null); // measured beep latency this run
  const offsetRef = useRef(reactionOffsetMs); // latest fixed offset, fallback at save time
  const correctionModeRef = useRef(correctionMode);
  const clockSyncRef = useRef(gate.clockSync); // latest sync (for ±X at finish)
  const athleteRef = useRef(athlete); // latest tags, read by saveRun without re-creating it
  const drillRef = useRef(drill);
  useEffect(() => {
    athleteRef.current = athlete;
  }, [athlete]);
  useEffect(() => {
    drillRef.current = drill;
  }, [drill]);
  useEffect(() => {
    offsetRef.current = reactionOffsetMs;
  }, [reactionOffsetMs]);
  useEffect(() => {
    correctionModeRef.current = correctionMode;
  }, [correctionMode]);
  useEffect(() => {
    clockSyncRef.current = gate.clockSync;
  }, [gate.clockSync]);

  // Hydrate the persisted current tags + recent athletes once.
  useEffect(() => {
    (async () => {
      try {
        setAthlete((await getSetting('current_athlete')) ?? '');
        setDrill((await getSetting('current_drill')) ?? '');
        setRecents(await getRecentAthletes());
      } catch {
        /* defaults */
      }
    })();
  }, []);

  // Persist the current tags so they survive an app restart (and across runs).
  const applyTags = useCallback((name: string, dr: string) => {
    setAthlete(name);
    setDrill(dr);
    setSetting('current_athlete', name).catch(() => {});
    setSetting('current_drill', dr).catch(() => {});
  }, []);

  // Audio: preload + warm up the output pipeline so the first real cue is low-latency.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await setAudioModeAsync({ playsInSilentMode: true });
        for (const p of [marks, set, go]) {
          p.volume = 0;
          p.play();
        }
        setTimeout(() => {
          if (cancelled) return;
          for (const p of [marks, set, go]) {
            p.pause();
            p.seekTo(0);
            p.volume = 1;
          }
        }, 200);
      } catch {
        /* players still loading; the real plays below will work once ready */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [marks, set, go]);

  // On the first playback progress after a GO, compute the per-run latency
  // breakdown (all ms). Engine-start is back-calculated as callbackTime -
  // currentTime, so it's independent of the status update interval:
  //   tAudioStart = tCallback - currentTime*1000   (player playback head start)
  //   bleOneway   = tRecv - tGoPhone               (gate GO -> phone receives GO)
  //   proc        = tPlay - tRecv                  (receipt -> go.play())
  //   audioGap    = tAudioStart - tPlay            (play() -> playback advances)
  //   beepEngine  = tAudioStart - tGoPhone         (gate GO -> engine audio start)
  // The CORRECTION subtracts beepEngine + ACOUSTIC_OUTPUT_MS (engine-start ->
  // sound at the speaker), i.e. the gate GO -> actual acoustic output.
  useEffect(() => {
    const sub = go.addListener('playbackStatusUpdate', (st) => {
      const m = runMeasureRef.current;
      if (!m || m.tAudioStart != null || !st.playing || st.currentTime <= 0) return;
      const tAudioStart = nowMs() - st.currentTime * 1000;
      m.tAudioStart = tAudioStart;
      const audioGap = tAudioStart - m.tPlay;
      const proc = m.tPlay - m.tRecv;
      let bleOneway: number | null = null;
      let beepEngine: number | null = null;
      if (m.tGoPhone != null) {
        bleOneway = m.tRecv - m.tGoPhone;
        beepEngine = tAudioStart - m.tGoPhone;
        runBeepLatencyRef.current = beepEngine + ACOUSTIC_OUTPUT_MS; // = full correction
      }
      if (audioGap >= 0 && audioGap < 2000) setMeasuredAudioLatencyMs(Math.round(audioGap));
      addLatencySample({ bleOneway, proc, audioGap, beepLatency: beepEngine, at: Date.now() });
      console.log(
        `[lat] bleOneway=${bleOneway?.toFixed(1) ?? 'n/a'} proc=${proc.toFixed(1)} audioGap=${audioGap.toFixed(1)} beepEngine=${beepEngine?.toFixed(1) ?? 'n/a'} +acoustic=${ACOUSTIC_OUTPUT_MS}`,
      );
    });
    return () => sub.remove();
  }, [go, setMeasuredAudioLatencyMs, addLatencySample]);

  // Replay a one-shot cue reliably. After a sound reaches its end the player sits
  // at the end, so play() alone is a no-op — it must be rewound first, and the
  // seek must COMPLETE before play() or playback starts from the end (silent),
  // which is why some countdown phases were intermittently quiet. Also force the
  // volume back to 1 in case the mount-time priming left it muted. (Latency isn't
  // critical here — only the GO cue is timing-sensitive, and it has its own path.)
  const playCue = useCallback((p: AudioPlayer) => {
    void (async () => {
      try {
        p.volume = 1;
        await p.seekTo(0);
        p.play();
      } catch {
        /* not ready */
      }
    })();
  }, []);

  const stopTick = useCallback(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
  }, []);

  const startRun = useCallback(() => {
    t0Ref.current = nowMs();
    finishedRef.current = false;
    activeRef.current = true;
    setResult(null);
    setCorr(null);
    setLiveSplit1Ms(null);
    setLiveMs(0);
    setRunState('running');
  }, []);

  const resetLocal = useCallback(() => {
    finishedRef.current = false;
    activeRef.current = false;
    stopTick();
    setRunState('idle');
    setResult(null);
    setCorr(null);
    setLiveSplit1Ms(null);
    setLiveMs(0);
    setPhaseLabel('');
  }, [stopTick]);

  const applyFinish = useCallback(
    (r: Result, src: string) => {
      if (finishedRef.current) return; // dedupe: event + recovery may both fire
      finishedRef.current = true;
      activeRef.current = false;
      stopTick();
      setResult(r);
      setLiveMs(r.totalMs);
      setPhaseLabel('');
      setRunState('finished');
      // Per-run latency subtraction (Mode 2). The athlete reacts to the phone beep,
      // which trails the gate GO by the beep latency, so raw split1 (GO->Gate1) is
      // inflated by it. correction = (actual acoustic output - gate GO) =
      // beepEngine (measured via clock sync) + ACOUSTIC_OUTPUT_MS (assumed). The
      // corrected reaction = split1 - correction (clamped at 0; flagged if raw <
      // correction). RAW gate values are always stored; the components go into
      // raw_json so everything is re-derivable. 'fixed' = manual offset fallback.
      let correction = 0;
      let source: 'synced' | 'fixed' = 'fixed';
      let beepEngine: number | null = null;
      if (r.mode === 2) {
        const c = runBeepLatencyRef.current; // = beepEngine + ACOUSTIC_OUTPUT_MS
        if (correctionModeRef.current === 'synced' && c != null) {
          correction = Math.max(0, Math.round(c));
          beepEngine = Math.round(c - ACOUSTIC_OUTPUT_MS);
          source = 'synced';
        } else {
          correction = offsetRef.current;
          source = 'fixed';
        }
      }
      const corrected = r.mode === 2 ? Math.max(0, r.split1Ms - correction) : r.split1Ms;
      const early = r.mode === 2 && r.split1Ms < correction;
      // Physical-plausibility guard: a corrected reaction below the human floor
      // means we subtracted more than the real beep latency (over-corrected), so
      // the number is a measurement artefact, not a real reaction time.
      const implausible = r.mode === 2 && correction > 0 && corrected < REACTION_FLOOR_MS;
      // ±X (≈1σ): RSS of clock-sync bound (minRtt/2, conservative — reducible with
      // a tighter BLE interval), the UNMEASURABLE acoustic-output uncertainty (the
      // term the gate buzzer removes), and residual audio-start noise.
      const cs = clockSyncRef.current;
      const eClk = cs ? cs.minRttMs / 2 : 0;
      const confMs =
        source === 'synced'
          ? Math.round(
              Math.sqrt(
                eClk * eClk +
                  ACOUSTIC_UNCERTAINTY_MS * ACOUSTIC_UNCERTAINTY_MS +
                  AUDIO_MEAS_NOISE_MS * AUDIO_MEAS_NOISE_MS,
              ),
            )
          : 0;
      setCorr({ correction, source, beepEngine, early, implausible, confMs });
      // Full per-run breakdown so the source of the run-to-run correction swing is
      // visible: which component (BLE delivery, audio gap, or the clock mapping)
      // moved. correction = bleOneway + proc + audioGap + acoustic. If the swing is
      // in the anchor/tGoPhone it's the clock mapping; if in audioGap/bleOneway it's
      // real pipeline jitter the correction is (correctly) measuring but can't beat.
      const m = runMeasureRef.current;
      const bleOneway = m && m.tGoPhone != null ? m.tRecv - m.tGoPhone : null;
      const proc = m ? m.tPlay - m.tRecv : null;
      const audioGap = m && m.tAudioStart != null ? m.tAudioStart - m.tPlay : null;
      const beepE = m && m.tAudioStart != null && m.tGoPhone != null ? m.tAudioStart - m.tGoPhone : null;
      if (r.mode === 2) {
        console.log(
          `[breakdown] raw=${r.split1Ms} corrected=${corrected} correction=${correction}(${source}) ` +
            `conf=±${confMs} implausible=${implausible} early=${early}\n` +
            `  components(ms): bleOneway=${fmtN(bleOneway)} proc=${fmtN(proc)} audioGap=${fmtN(audioGap)} ` +
            `beepEngine=${fmtN(beepE)} +acoustic=${ACOUSTIC_OUTPUT_MS}\n` +
            `  stamps(ms): tGoPhone=${fmtN(m?.tGoPhone ?? null)} tRecv=${fmtN(m?.tRecv ?? null)} ` +
            `tPlay=${fmtN(m?.tPlay ?? null)} tAudioStart=${fmtN(m?.tAudioStart ?? null)} t0us=${m?.t0us ?? 'n/a'}\n` +
            `  anchor: ${cs ? `g0Us=${cs.anchor.g0Us} p0Ms=${cs.anchor.p0Ms.toFixed(1)} minRtt=${cs.minRttMs.toFixed(1)} offsetSpread=${cs.offsetSpreadMs.toFixed(1)}` : 'none (fixed offset)'}`,
        );
      }
      setDbg(`finish(${src}) raw ${fmt(r.totalMs, 3)}s · −${correction}ms(${source}) · saving…`);
      const rawJson = JSON.stringify({
        source,
        correction,
        corrected,
        beepEngine,
        acousticMs: ACOUSTIC_OUTPUT_MS,
        confMs,
        early,
        implausible,
        bleOneway: bleOneway != null ? Math.round(bleOneway) : null,
        proc: proc != null ? Math.round(proc) : null,
        audioGap: audioGap != null ? Math.round(audioGap) : null,
        minRttMs: cs?.minRttMs ?? null,
        offsetSpreadMs: cs?.offsetSpreadMs ?? null,
      });
      const tagName = athleteRef.current.trim();
      const tagDrill = drillRef.current.trim();
      setFinishedTags({ name: tagName, drill: tagDrill });
      saveRun({
        mode: r.mode,
        totalMs: r.totalMs, // RAW authoritative (gate clock)
        split1Ms: r.split1Ms, // RAW authoritative
        split2Ms: r.split2Ms,
        reactionOffsetMs: correction,
        rawJson,
        status: early || implausible ? 'suspect' : r.flags & 0x01 ? 'valid' : 'invalid',
        athleteName: tagName,
        drillType: tagDrill,
      })
        .then(() => {
          console.log('[saveRun] ok');
          if (tagName) addRecentAthlete(tagName).then(setRecents).catch(() => {});
          const shown = r.mode === 2 ? Math.max(0, r.totalMs - correction) : r.totalMs;
          setDbg(`finish(${src}) ${fmt(shown, 3)}s · saved ✓`);
        })
        .catch((e) => {
          console.warn('[saveRun] FAILED', e);
          setDbg(`finish(${src}) · SAVE FAILED: ${String(e)}`);
        });
    },
    [stopTick],
  );

  // Reconcile local state against an authoritative gate state value. Drives
  // recovery from dropped notifications (called from STATE events, Status
  // notifications, and the poll).
  const reconcileState = useCallback(
    (s: GateState) => {
      setGateState(s);
      if (s === GateState.Idle) {
        resetLocal();
        return;
      }
      if (s === GateState.Result) {
        if (activeRef.current && !finishedRef.current) {
          readLastResultNow().then((lr) => {
            if (lr) applyFinish(toResult(lr), 'recovered');
          });
        }
        return;
      }
      const running =
        s === GateState.M1Running || s === GateState.M2ToGate1 || s === GateState.M2ToGate2;
      if (running && !activeRef.current && !finishedRef.current) {
        console.log('[reconcile] missed START/GO — starting live timer from gate state');
        startRun();
      }
    },
    [resetLocal, readLastResultNow, applyFinish, startRun],
  );

  // BLE event stream — the instant path.
  useEffect(() => {
    const off = subscribe((_raw, ev, atMs) => {
      if (!ev) return;
      switch (ev.type) {
        case Evt.State:
          reconcileState(ev.state);
          break;
        case Evt.Countdown:
          setRunState('countdown');
          if (ev.phase === 1) {
            setPhaseLabel('On your marks');
            playCue(marks);
          } else if (ev.phase === 2) {
            setPhaseLabel('Set');
            playCue(set);
          } else {
            setPhaseLabel('Ready…');
            // Prime the audio output right before the (random) GO: a brief silent
            // play keeps the session/decoder warm so the GO play() is an instant,
            // no-await start. Re-seek to 0 + restore volume after priming.
            try {
              go.volume = 0;
              go.seekTo(0);
              go.play();
              if (primingTimerRef.current) clearTimeout(primingTimerRef.current);
              primingTimerRef.current = setTimeout(() => {
                try {
                  go.pause();
                  go.seekTo(0);
                  go.volume = 1;
                  goPreSeekedRef.current = true;
                } catch {
                  /* ignore */
                }
              }, 120);
            } catch {
              /* ignore */
            }
          }
          break;
        case Evt.Go: {
          // Fire audio FIRST, before any React state work, to minimise latency.
          if (primingTimerRef.current) {
            clearTimeout(primingTimerRef.current);
            primingTimerRef.current = null;
          }
          let tPlay = atMs;
          try {
            go.volume = 1;
            if (!goPreSeekedRef.current) go.seekTo(0);
            tPlay = nowMs();
            go.play();
          } catch {
            /* ignore */
          }
          goPreSeekedRef.current = false;
          // Set up per-run latency measurement (resolved in the playback callback).
          runBeepLatencyRef.current = null;
          runMeasureRef.current = {
            tRecv: atMs,
            t0us: ev.t0us,
            tGoPhone: gateToPhoneMs(ev.t0us),
            tPlay,
            tAudioStart: null,
          };
          setPhaseLabel('GO!');
          startRun();
          break;
        }
        case Evt.Start:
          setPhaseLabel('');
          startRun();
          break;
        case Evt.Split:
          if (ev.index === 1) setLiveSplit1Ms(ev.splitMs);
          break;
        case Evt.Finish:
          applyFinish(
            {
              mode: ev.mode,
              totalMs: ev.totalMs,
              split1Ms: ev.split1Ms,
              split2Ms: ev.split2Ms,
              flags: ev.flags,
            },
            'event',
          );
          break;
        default:
          break;
      }
    });
    return off;
  }, [subscribe, reconcileState, applyFinish, startRun, playCue, marks, set, go, gateToPhoneMs]);

  // Reconcile whenever Status updates (notification or poll).
  useEffect(() => {
    if (gateStatus) reconcileState(gateStatus.state);
  }, [gateStatus, reconcileState]);

  // Safety-net poll: while the gate is mid-run, refresh Status so a dropped
  // notification can't strand the UI. Reads are reliable; notifications may drop.
  const shouldPoll =
    status === 'connected' &&
    gateState != null &&
    gateState !== GateState.Idle &&
    gateState !== GateState.Result;
  useEffect(() => {
    if (!shouldPoll) return;
    const id = setInterval(() => {
      readStatusNow();
    }, 600);
    return () => clearInterval(id);
  }, [shouldPoll, readStatusNow]);

  // Live ticking while running.
  useEffect(() => {
    if (runState === 'running') {
      tickRef.current = setInterval(() => setLiveMs(nowMs() - t0Ref.current), 33);
      return () => stopTick();
    }
    return undefined;
  }, [runState, stopTick]);

  // Keep the screen awake during a countdown or a run.
  useEffect(() => {
    if (runState === 'countdown' || runState === 'running') {
      activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    } else {
      deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
    }
  }, [runState]);

  const connected = status === 'connected';
  const isM2Armed = gateState === GateState.M2Armed;
  const isIdleState = gateState === GateState.Idle || gateState === null;
  const shownCorrection = corr ? corr.correction : reactionOffsetMs;
  const adjReactionMs =
    result && result.mode === 2 ? Math.max(0, result.split1Ms - shownCorrection) : 0;
  // The total is ALWAYS the raw gate measurement. The reaction correction is
  // unreliable (docs/LATENCY.md) so it never reduces the total — it's applied
  // only to the reaction, and only in dev mode. Mode 2 total = GO->G2 (still
  // includes the GO-beep latency, but that's a real gate-clock interval, not a
  // fudged number). Mode 1 total is unaffected.
  const big = result
    ? fmt(result.totalMs, 3)
    : fmt(liveMs, runState === 'running' ? 2 : 3);

  const currentTags = formatTags(athlete, drill);
  const finishedTagStr = finishedTags ? formatTags(finishedTags.name, finishedTags.drill) : '';

  return (
    <View style={styles.container}>
      <ConnChip />

      {/* Compact, optional tag bar. Persists across runs; tap to set, ✕ to clear. */}
      <Pressable style={styles.tagBar} onPress={() => setTagOpen(true)}>
        <Text
          style={[styles.tagBarText, !currentTags && styles.tagBarPlaceholder]}
          numberOfLines={1}
        >
          {currentTags || '＋  Athlete / drill (optional)'}
        </Text>
        {athlete || drill ? (
          <Pressable onPress={() => applyTags('', '')} hitSlop={8}>
            <Text style={styles.tagClear}>✕</Text>
          </Pressable>
        ) : (
          <Text style={styles.tagSet}>Set</Text>
        )}
      </Pressable>

      <View style={styles.stage}>
        {phaseLabel ? <Text style={styles.phase}>{phaseLabel}</Text> : null}
        <Text style={[styles.timer, runState === 'finished' && styles.timerDone]}>{big}</Text>
        <Text style={styles.unit}>seconds</Text>
        {runState === 'finished' && finishedTagStr ? (
          <Text style={styles.resultTags}>{finishedTagStr}</Text>
        ) : null}

        {result && result.mode === 2 && !devMode ? (
          // Clean mode: G1→G2 (exact) + total; reaction shown RAW with a caveat,
          // never the corrected number (it can go sub-floor). See docs/LATENCY.md.
          <View style={styles.splits}>
            <Split label="Reaction → G1" ms={result.split1Ms} caveat="+ beep latency (uncorrected)" muted />
            <Split label="G1 → G2" ms={result.split2Ms} />
            <Split label="Total" ms={result.totalMs} strong />
            <Text style={styles.offsetNote}>
              Reaction and total include the GO-beep delay, which can&apos;t be corrected reliably on
              the phone. The Gate 1 → Gate 2 split is exact.
            </Text>
          </View>
        ) : null}

        {result && result.mode === 2 && devMode ? (
          <View style={styles.splits}>
            <Split
              label="Reaction → G1"
              ms={adjReactionMs}
              raw={result.split1Ms}
              conf={corr && corr.confMs > 0 ? corr.confMs : undefined}
              unreliable={!!corr?.implausible}
            />
            <Split label="G1 → G2" ms={result.split2Ms} />
            <Split label="Total (GO → G2, raw)" ms={result.totalMs} strong />
            {corr && corr.confMs > 0 && !corr.implausible ? (
              <Text style={styles.accuracyNote}>reaction accuracy ±{corr.confMs} ms (clock-synced)</Text>
            ) : null}
            <Text style={styles.offsetNote}>
              {corr?.source === 'synced'
                ? `clock-synced · −${shownCorrection} ms (beep ${corr.beepEngine ?? '?'}+${ACOUSTIC_OUTPUT_MS} acoustic)`
                : `fixed offset · −${shownCorrection} ms · not clock-synced this run (no ±X)`}
            </Text>
            {corr?.implausible ? (
              <Text style={styles.earlyNote}>
                ⚠ reaction over-corrected (below ~{REACTION_FLOOR_MS} ms human floor) — unreliable.
                The GO-beep latency measured this run exceeded the real reaction.
              </Text>
            ) : null}
          </View>
        ) : null}

        {!result && liveSplit1Ms != null ? (
          <View style={styles.splits}>
            <Split label="Split 1" ms={liveSplit1Ms} />
          </View>
        ) : null}

        <Text style={styles.hint}>{hintFor(connected, gateState, runState)}</Text>
        {dbg ? <Text style={styles.dbg}>{dbg}</Text> : null}
      </View>

      <View style={styles.controls}>
        <Row>
          <Btn label="Arm Mode 1" onPress={gate.arm1} disabled={!connected || !isIdleState} />
          <Btn label="Arm Mode 2" onPress={gate.arm2} disabled={!connected || !isIdleState} />
        </Row>
        <Row>
          <Btn
            label="Start sequence"
            onPress={() => gate.startSequence()}
            disabled={!connected || !isM2Armed}
            kind="go"
          />
          <Btn label="Reset" onPress={gate.reset} disabled={!connected || isIdleState} kind="warn" />
        </Row>
      </View>

      <TagPickerModal
        visible={tagOpen}
        initialName={athlete}
        initialDrill={drill}
        recents={recents}
        onClose={() => setTagOpen(false)}
        onSubmit={applyTags}
      />
    </View>
  );
}

function hintFor(connected: boolean, gs: GateState | null, rs: RunState): string {
  if (!connected) return 'Not connected — tap Connect above.';
  if (rs === 'finished') return 'Saved — tap Reset for the next run.';
  switch (gs) {
    case GateState.M1Armed:
      return 'Run through Gate 1 to start the clock.';
    case GateState.M2Armed:
      return 'Tap Start sequence, or hold/release Button 2 on the gate.';
    case GateState.M2Countdown:
      return 'Get ready…';
    case GateState.M1Running:
    case GateState.M2ToGate1:
    case GateState.M2ToGate2:
      return 'Running…';
    default:
      return 'Pick a mode to arm.';
  }
}

function ConnChip() {
  const gate = useGate();
  const s = gate.status;
  const label =
    s === 'connected'
      ? `Gate connected${gate.gateStatus ? ` · ${STATE_NAME[gate.gateStatus.state] ?? ''}` : ''}${
          gate.gateStatus ? ` · runs ${gate.gateStatus.runCount}` : ''
        }${gate.gateStatus && !gate.gateStatus.finishLinkOk ? ' · finish ⚠' : ''}`
      : s === 'scanning'
        ? 'Scanning…'
        : s === 'connecting'
          ? 'Connecting…'
          : s === 'reconnecting'
            ? 'Reconnecting…'
            : 'Disconnected';
  const busy = s === 'scanning' || s === 'connecting' || s === 'reconnecting';
  const dotStyle = s === 'connected' ? styles.dotOn : busy ? styles.dotBusy : styles.dotOff;
  const showDisconnect = s === 'connected' || s === 'reconnecting';
  return (
    <View style={styles.chipRow}>
      <View style={[styles.dot, dotStyle]} />
      <Text style={styles.chipText}>{label}</Text>
      <View style={{ flex: 1 }} />
      {showDisconnect ? (
        <Pressable onPress={gate.disconnect} hitSlop={8}>
          <Text style={styles.chipAction}>{s === 'reconnecting' ? 'Cancel' : 'Disconnect'}</Text>
        </Pressable>
      ) : (
        <Pressable onPress={gate.quickConnect} disabled={busy || !gate.adapterOn} hitSlop={8}>
          <Text style={[styles.chipAction, (busy || !gate.adapterOn) && styles.dim]}>Connect</Text>
        </Pressable>
      )}
    </View>
  );
}

function Split({
  label,
  ms,
  raw,
  conf,
  strong,
  unreliable,
  caveat,
  muted,
}: {
  label: string;
  ms: number;
  raw?: number;
  conf?: number;
  strong?: boolean;
  unreliable?: boolean;
  caveat?: string; // small note under the value (e.g. clean-mode "+ beep latency")
  muted?: boolean; // de-emphasise the value (not an authoritative metric)
}) {
  return (
    <View style={styles.splitRow}>
      <Text style={[styles.splitLabel, strong && styles.splitStrong]}>{label}</Text>
      <View style={styles.splitValCol}>
        {/* Over-corrected reactions are shown as "unreliable", not a fake time. */}
        <Text
          style={[
            styles.splitVal,
            strong && styles.splitStrong,
            unreliable && styles.splitUnreliable,
            muted && styles.splitMuted,
          ]}
        >
          {unreliable ? 'unreliable' : `${fmt(ms, 3)}s${conf != null ? ` ±${conf}ms` : ''}`}
        </Text>
        {raw != null ? <Text style={styles.splitRaw}>raw {fmt(raw, 3)}s</Text> : null}
        {caveat ? <Text style={styles.splitRaw}>{caveat}</Text> : null}
      </View>
    </View>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <View style={styles.row}>{children}</View>;
}

function Btn({
  label,
  onPress,
  disabled,
  kind,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  kind?: 'go' | 'warn';
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.btn,
        kind === 'go' && styles.btnGo,
        kind === 'warn' && styles.btnWarn,
        (disabled || pressed) && styles.dim,
      ]}
    >
      <Text style={styles.btnText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0e1116', paddingTop: 56, paddingHorizontal: 16 },
  chipRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  dotOn: { backgroundColor: '#22c55e' },
  dotOff: { backgroundColor: '#64748b' },
  dotBusy: { backgroundColor: '#f59e0b' },
  chipText: { color: '#cbd5e1', fontSize: 13 },
  chipAction: { color: '#60a5fa', fontWeight: '700', fontSize: 13 },
  tagBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#161b22',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    marginTop: 2,
  },
  tagBarText: { color: '#e2e8f0', fontSize: 14, fontWeight: '600', flex: 1 },
  tagBarPlaceholder: { color: '#64748b', fontWeight: '400' },
  tagClear: { color: '#fb923c', fontSize: 15, fontWeight: '800' },
  tagSet: { color: '#60a5fa', fontSize: 13, fontWeight: '700' },
  resultTags: { color: '#94a3b8', fontSize: 15, fontWeight: '600', marginTop: 6 },
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  phase: { color: '#fbbf24', fontSize: 22, fontWeight: '700', marginBottom: 8 },
  timer: { color: '#fff', fontSize: 76, fontWeight: '800', fontVariant: ['tabular-nums'] },
  timerDone: { color: '#34d399' },
  unit: { color: '#64748b', fontSize: 14, marginTop: -6 },
  splits: { marginTop: 20, width: '70%' },
  splitRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4 },
  splitLabel: { color: '#94a3b8', fontSize: 15 },
  splitValCol: { alignItems: 'flex-end' },
  splitVal: { color: '#e2e8f0', fontSize: 15, fontVariant: ['tabular-nums'] },
  splitUnreliable: { color: '#fb923c', fontWeight: '700' },
  splitMuted: { color: '#94a3b8' },
  splitRaw: { color: '#475569', fontSize: 11, fontVariant: ['tabular-nums'] },
  splitStrong: { color: '#fff', fontWeight: '800' },
  accuracyNote: { color: '#38bdf8', fontSize: 13, fontWeight: '700', marginTop: 10, textAlign: 'center' },
  offsetNote: { color: '#64748b', fontSize: 11, marginTop: 6, textAlign: 'center' },
  earlyNote: { color: '#fb923c', fontSize: 11, marginTop: 4, textAlign: 'center' },
  hint: { color: '#64748b', fontSize: 13, marginTop: 24, textAlign: 'center' },
  dbg: { color: '#475569', fontSize: 11, marginTop: 8, textAlign: 'center', fontVariant: ['tabular-nums'] },
  controls: { paddingBottom: 12 },
  row: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  btn: { flex: 1, backgroundColor: '#2563eb', paddingVertical: 14, borderRadius: 12, alignItems: 'center' },
  btnGo: { backgroundColor: '#16a34a' },
  btnWarn: { backgroundColor: '#b4541f' },
  btnText: { color: '#fff', fontWeight: '700' },
  dim: { opacity: 0.4 },
});
