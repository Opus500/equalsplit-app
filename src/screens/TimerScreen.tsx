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
import { saveRun } from '../db/database';

const KEEP_AWAKE_TAG = 'equalsplit-run';
const nowMs = () =>
  typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now();

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
  const { subscribe, gateStatus, status, readStatusNow, readLastResultNow } = gate;
  const { reactionOffsetMs, setMeasuredAudioLatencyMs } = useSettings();

  const marks = useAudioPlayer(require('../../assets/sounds/marks.wav'));
  const set = useAudioPlayer(require('../../assets/sounds/set.wav'));
  // Tight status updates so we can timestamp when the GO beep actually starts.
  const go = useAudioPlayer(require('../../assets/sounds/go.wav'), { updateInterval: 50 });

  const [runState, setRunState] = useState<RunState>('idle');
  const [phaseLabel, setPhaseLabel] = useState('');
  const [liveMs, setLiveMs] = useState(0);
  const [liveSplit1Ms, setLiveSplit1Ms] = useState<number | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [gateState, setGateState] = useState<GateState | null>(null);
  const [dbg, setDbg] = useState('');

  const t0Ref = useRef(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const finishedRef = useRef(false);
  const activeRef = useRef(false);
  const goPreSeekedRef = useRef(false);
  const goPlayedAtRef = useRef<number | null>(null); // when go.play() was called
  const offsetRef = useRef(reactionOffsetMs); // latest offset, read at save time
  useEffect(() => {
    offsetRef.current = reactionOffsetMs;
  }, [reactionOffsetMs]);

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

  // Measure phone-side beep latency: the gap between calling go.play() (on GO
  // event arrival) and the audio actually advancing. This is the AUDIO-pipeline
  // component of the total beep latency; the BLE-delivery component is not
  // directly measurable here without clock sync (t0_us from the GO event is the
  // gate's micros() and can't be mapped to phone time), so the applied offset
  // (Calibration screen) covers the total. Precision is bounded by updateInterval.
  useEffect(() => {
    const sub = go.addListener('playbackStatusUpdate', (st) => {
      if (goPlayedAtRef.current != null && st.playing && st.currentTime > 0) {
        const measured = Math.round(nowMs() - goPlayedAtRef.current);
        goPlayedAtRef.current = null;
        if (measured >= 0 && measured < 2000) {
          setMeasuredAudioLatencyMs(measured);
          console.log(`[audio] GO play→start latency ≈ ${measured}ms`);
        }
      }
    });
    return () => sub.remove();
  }, [go, setMeasuredAudioLatencyMs]);

  const playCue = useCallback((p: AudioPlayer) => {
    try {
      p.seekTo(0);
      p.play();
    } catch {
      /* not ready */
    }
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
      // Latency math (Mode 2): the athlete reacts to the phone beep, which trails
      // the gate's GO by ~offset ms, so the gate's raw reaction (split1) is
      // inflated by that. adjusted_reaction = raw_split1 - offset; adjusted_total
      // = raw_total - offset (split2, gate1→gate2, is unaffected). We store the
      // RAW gate values plus the offset applied, so adjusted is derivable and the
      // offset can be re-tuned later. Mode 1 has no reaction, so offset = 0.
      const offset = r.mode === 2 ? offsetRef.current : 0;
      console.log(`[FINISH:${src}] mode=${r.mode} total=${r.totalMs} s1=${r.split1Ms} s2=${r.split2Ms} offset=${offset}`);
      setDbg(`finish(${src}) raw ${fmt(r.totalMs, 3)}s · offset ${offset}ms · saving…`);
      saveRun({
        mode: r.mode,
        totalMs: r.totalMs, // RAW authoritative (gate clock)
        split1Ms: r.split1Ms, // RAW authoritative
        split2Ms: r.split2Ms,
        reactionOffsetMs: offset,
        status: r.flags & 0x01 ? 'valid' : 'invalid',
      })
        .then(() => {
          console.log('[saveRun] ok');
          const shown = r.mode === 2 ? Math.max(0, r.totalMs - offset) : r.totalMs;
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
    const off = subscribe((_raw, ev) => {
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
            try {
              go.seekTo(0); // pre-position the GO beep so play() at GO is instant
              goPreSeekedRef.current = true;
            } catch {
              /* ignore */
            }
          }
          break;
        case Evt.Go:
          // Fire audio FIRST, before any React state work, to minimise latency.
          try {
            if (!goPreSeekedRef.current) go.seekTo(0);
            goPlayedAtRef.current = nowMs(); // mark for latency measurement
            go.play();
          } catch {
            goPlayedAtRef.current = null;
          }
          goPreSeekedRef.current = false;
          setPhaseLabel('GO!');
          startRun();
          break;
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
  }, [subscribe, reconcileState, applyFinish, startRun, playCue, marks, set, go]);

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
  const offset = reactionOffsetMs;
  const adjReactionMs = result && result.mode === 2 ? Math.max(0, result.split1Ms - offset) : 0;
  const adjTotalMs =
    result && result.mode === 2 ? Math.max(0, result.totalMs - offset) : (result?.totalMs ?? 0);
  const big = result
    ? fmt(result.mode === 2 ? adjTotalMs : result.totalMs, 3)
    : fmt(liveMs, runState === 'running' ? 2 : 3);

  return (
    <View style={styles.container}>
      <ConnChip />

      <View style={styles.stage}>
        {phaseLabel ? <Text style={styles.phase}>{phaseLabel}</Text> : null}
        <Text style={[styles.timer, runState === 'finished' && styles.timerDone]}>{big}</Text>
        <Text style={styles.unit}>seconds</Text>

        {result && result.mode === 2 ? (
          <View style={styles.splits}>
            <Split label="Reaction → G1" ms={adjReactionMs} raw={result.split1Ms} />
            <Split label="G1 → G2" ms={result.split2Ms} />
            <Split label="Total" ms={adjTotalMs} raw={result.totalMs} strong />
            <Text style={styles.offsetNote}>adjusted · −{offset} ms beep-latency offset</Text>
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
  strong,
}: {
  label: string;
  ms: number;
  raw?: number;
  strong?: boolean;
}) {
  return (
    <View style={styles.splitRow}>
      <Text style={[styles.splitLabel, strong && styles.splitStrong]}>{label}</Text>
      <View style={styles.splitValCol}>
        <Text style={[styles.splitVal, strong && styles.splitStrong]}>{fmt(ms, 3)}s</Text>
        {raw != null ? <Text style={styles.splitRaw}>raw {fmt(raw, 3)}s</Text> : null}
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
  splitRaw: { color: '#475569', fontSize: 11, fontVariant: ['tabular-nums'] },
  splitStrong: { color: '#fff', fontWeight: '800' },
  offsetNote: { color: '#64748b', fontSize: 11, marginTop: 8, textAlign: 'center' },
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
