// Main v1 screen. Arms modes, runs a local live timer for the live feel on
// START/GO, snaps to the gate's authoritative time on FINISH, plays the
// start-sequence audio cues, and persists each finished run to SQLite.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { setAudioModeAsync, useAudioPlayer, type AudioPlayer } from 'expo-audio';

import { useGate } from '../ble/GateProvider';
import { Evt, GateState, STATE_NAME } from '../ble/constants';
import { saveRun } from '../db/database';

const KEEP_AWAKE_TAG = 'equalsplit-run';
const nowMs = () =>
  typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now();

type RunState = 'idle' | 'countdown' | 'running' | 'finished';
type Result = { mode: number; totalMs: number; split1Ms: number; split2Ms: number; flags: number };

const fmt = (ms: number, dec: number) => (Math.max(0, ms) / 1000).toFixed(dec);

export default function TimerScreen() {
  const gate = useGate();
  const { subscribe, gateStatus } = gate;

  const marks = useAudioPlayer(require('../../assets/sounds/marks.wav'));
  const set = useAudioPlayer(require('../../assets/sounds/set.wav'));
  const go = useAudioPlayer(require('../../assets/sounds/go.wav'));

  const [runState, setRunState] = useState<RunState>('idle');
  const [phaseLabel, setPhaseLabel] = useState('');
  const [liveMs, setLiveMs] = useState(0);
  const [liveSplit1Ms, setLiveSplit1Ms] = useState<number | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [gateState, setGateState] = useState<GateState | null>(null);

  const t0Ref = useRef(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const savedRef = useRef(false);

  // Preload audio + allow playback while the phone is on silent (iOS).
  useEffect(() => {
    setAudioModeAsync({ playsInSilentMode: true }).catch(() => {});
  }, []);

  useEffect(() => {
    if (gateStatus) setGateState(gateStatus.state);
  }, [gateStatus]);

  const playCue = useCallback((p: AudioPlayer) => {
    try {
      p.seekTo(0);
      p.play();
    } catch {
      /* player not ready yet; ignore */
    }
  }, []);

  const stopTick = useCallback(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
  }, []);

  const startRun = useCallback(() => {
    t0Ref.current = nowMs();
    savedRef.current = false;
    setResult(null);
    setLiveSplit1Ms(null);
    setLiveMs(0);
    setRunState('running');
  }, []);

  // Event handling. Only refs + stable setters are touched, so the listener
  // never goes stale and we don't re-subscribe on every render.
  useEffect(() => {
    const off = subscribe((_raw, ev) => {
      if (!ev) return;
      switch (ev.type) {
        case Evt.State:
          setGateState(ev.state);
          if (ev.state === GateState.Idle) {
            setRunState('idle');
            setPhaseLabel('');
            setResult(null);
            setLiveSplit1Ms(null);
            setLiveMs(0);
          }
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
          }
          break;
        case Evt.Go:
          setPhaseLabel('GO!');
          playCue(go);
          startRun();
          break;
        case Evt.Start:
          setPhaseLabel('');
          startRun();
          break;
        case Evt.Split:
          if (ev.index === 1) setLiveSplit1Ms(ev.splitMs);
          break;
        case Evt.Finish: {
          stopTick();
          const r: Result = {
            mode: ev.mode,
            totalMs: ev.totalMs,
            split1Ms: ev.split1Ms,
            split2Ms: ev.split2Ms,
            flags: ev.flags,
          };
          setResult(r);
          setLiveMs(ev.totalMs);
          setPhaseLabel('');
          setRunState('finished');
          if (!savedRef.current) {
            savedRef.current = true;
            saveRun({
              mode: r.mode,
              totalMs: r.totalMs,
              split1Ms: r.split1Ms,
              split2Ms: r.split2Ms,
              status: r.flags & 0x01 ? 'valid' : 'invalid',
            }).catch(() => {});
          }
          break;
        }
        default:
          break;
      }
    });
    return off;
  }, [subscribe, playCue, startRun, stopTick, marks, set, go]);

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

  const connected = gate.status === 'connected';
  const isM2Armed = gateState === GateState.M2Armed;
  const isIdleState = gateState === GateState.Idle || gateState === null;
  const big = result ? fmt(result.totalMs, 3) : fmt(liveMs, runState === 'running' ? 2 : 3);

  return (
    <View style={styles.container}>
      <ConnChip />

      <View style={styles.stage}>
        {phaseLabel ? <Text style={styles.phase}>{phaseLabel}</Text> : null}
        <Text style={[styles.timer, runState === 'finished' && styles.timerDone]}>{big}</Text>
        <Text style={styles.unit}>seconds</Text>

        {result && result.mode === 2 ? (
          <View style={styles.splits}>
            <Split label="Reaction → G1" ms={result.split1Ms} />
            <Split label="G1 → G2" ms={result.split2Ms} />
            <Split label="Total" ms={result.totalMs} strong />
          </View>
        ) : null}

        {!result && liveSplit1Ms != null ? (
          <View style={styles.splits}>
            <Split label="Split 1" ms={liveSplit1Ms} />
          </View>
        ) : null}

        <Text style={styles.hint}>{hintFor(connected, gateState, runState)}</Text>
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
          <Btn
            label="Reset"
            onPress={gate.reset}
            disabled={!connected || isIdleState}
            kind="warn"
          />
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
  const label =
    gate.status === 'connected'
      ? `Gate connected${gate.gateStatus ? ` · ${STATE_NAME[gate.gateStatus.state] ?? ''}` : ''}${
          gate.gateStatus && !gate.gateStatus.finishLinkOk ? ' · finish ⚠' : ''
        }`
      : gate.status === 'scanning'
        ? 'Scanning…'
        : gate.status === 'connecting'
          ? 'Connecting…'
          : 'Disconnected';
  const busy = gate.status === 'scanning' || gate.status === 'connecting';
  return (
    <View style={styles.chipRow}>
      <View style={[styles.dot, gate.status === 'connected' ? styles.dotOn : styles.dotOff]} />
      <Text style={styles.chipText}>{label}</Text>
      <View style={{ flex: 1 }} />
      {gate.status === 'connected' ? (
        <Pressable onPress={gate.disconnect} hitSlop={8}>
          <Text style={styles.chipAction}>Disconnect</Text>
        </Pressable>
      ) : (
        <Pressable onPress={gate.quickConnect} disabled={busy || !gate.adapterOn} hitSlop={8}>
          <Text style={[styles.chipAction, (busy || !gate.adapterOn) && styles.dim]}>Connect</Text>
        </Pressable>
      )}
    </View>
  );
}

function Split({ label, ms, strong }: { label: string; ms: number; strong?: boolean }) {
  return (
    <View style={styles.splitRow}>
      <Text style={[styles.splitLabel, strong && styles.splitStrong]}>{label}</Text>
      <Text style={[styles.splitVal, strong && styles.splitStrong]}>{fmt(ms, 3)}s</Text>
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
  chipText: { color: '#cbd5e1', fontSize: 13 },
  chipAction: { color: '#60a5fa', fontWeight: '700', fontSize: 13 },
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  phase: { color: '#fbbf24', fontSize: 22, fontWeight: '700', marginBottom: 8 },
  timer: { color: '#fff', fontSize: 76, fontWeight: '800', fontVariant: ['tabular-nums'] },
  timerDone: { color: '#34d399' },
  unit: { color: '#64748b', fontSize: 14, marginTop: -6 },
  splits: { marginTop: 20, width: '70%' },
  splitRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  splitLabel: { color: '#94a3b8', fontSize: 15 },
  splitVal: { color: '#e2e8f0', fontSize: 15, fontVariant: ['tabular-nums'] },
  splitStrong: { color: '#fff', fontWeight: '800' },
  hint: { color: '#64748b', fontSize: 13, marginTop: 24, textAlign: 'center' },
  controls: { paddingBottom: 12 },
  row: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  btn: { flex: 1, backgroundColor: '#2563eb', paddingVertical: 14, borderRadius: 12, alignItems: 'center' },
  btnGo: { backgroundColor: '#16a34a' },
  btnWarn: { backgroundColor: '#b4541f' },
  btnText: { color: '#fff', fontWeight: '700' },
  dim: { opacity: 0.4 },
});
