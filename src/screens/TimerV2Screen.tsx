// Stage-2 Timer, on the v2 raw-event engine (Mode 1 only). Behind the dev
// setting "Use v2 engine"; the v1 TimerScreen is the default. Drives off the
// shared V2Provider session (auto discover/assign/sync/offset), arms the app-
// side engine, runs a live timer from the display offset, and saves each finish
// to the SAME SQLite history as v1 (mode 1, total = the g1→g2 split).

import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

import { useGate } from '../ble/GateProvider';
import { useV2 } from '../ble/V2Provider';
import type { V2Run } from '../ble/v2';
import { getSetting, saveRun, setSetting } from '../db/database';
import { TagPickerModal, formatTags } from '../components/TagPicker';
import { SetControl } from '../components/SetControl';
import { UpNextStrip } from '../components/UpNextStrip';
import { useRoster } from '../roster/RosterProvider';
import { runShareLine, shareText } from '../share';

const KEEP_AWAKE_TAG = 'equalsplit-run-v2';
const nowMs = () =>
  typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now();
const fmt = (ms: number, dec: number) => (Math.max(0, ms) / 1000).toFixed(dec);

export default function TimerV2Screen() {
  const v2 = useV2();
  const gate = useGate();

  // Retain the v2 session while this screen is mounted (ref-counted with the Lab).
  useEffect(() => {
    v2.retain();
    return v2.release;
  }, [v2.retain, v2.release]);

  const roster = useRoster();
  const [liveMs, setLiveMs] = useState(0);
  const [dbg, setDbg] = useState('');
  const [drill, setDrill] = useState('');
  const [tagOpen, setTagOpen] = useState(false);
  const [finishedTags, setFinishedTags] = useState<{ name: string; drill: string } | null>(null);

  // Attribution comes from the roster queue now, not a free-text tag. Held in a
  // ref so the save effect reads whoever was up at the moment the run landed.
  const currentAthleteRef = useRef(roster.currentAthlete);
  currentAthleteRef.current = roster.currentAthlete;
  const drillRef = useRef(drill);
  const t0Ref = useRef(0);
  const savedRef = useRef<V2Run | null>(null);
  useEffect(() => {
    drillRef.current = drill;
  }, [drill]);

  // Hydrate the persisted drill tag (shared with the v1 Timer).
  useEffect(() => {
    (async () => {
      try {
        setDrill((await getSetting('current_drill')) ?? '');
      } catch {
        /* defaults */
      }
    })();
  }, []);

  const applyTags = useCallback((_name: string, dr: string) => {
    setDrill(dr);
    setSetting('current_drill', dr).catch(() => {});
  }, []);

  // Live timer while running: t0 = the start break mapped to phone time (falls
  // back to its BLE arrival). The FINAL split uses gate timestamps, so this is
  // just for the running feel.
  useEffect(() => {
    if (!v2.running) return undefined;
    const startPhone = v2.gateToPhoneMs(v2.running.startUs) ?? v2.running.startAtMs;
    t0Ref.current = startPhone;
    setLiveMs(Math.max(0, nowMs() - startPhone));
    const id = setInterval(() => setLiveMs(Math.max(0, nowMs() - t0Ref.current)), 33);
    return () => clearInterval(id);
  }, [v2.running, v2.gateToPhoneMs]);

  // Save each new finished run (mode 1, total = split). Withhold if not synced.
  useEffect(() => {
    const run = v2.lastRun;
    if (!run || savedRef.current === run) return;
    savedRef.current = run;
    if (!run.synced) {
      setDbg('gates not time-synced — result withheld (not saved)');
      return;
    }
    const who = currentAthleteRef.current;
    const dr = drillRef.current.trim();
    setFinishedTags({ name: who?.display_name ?? '', drill: dr });
    saveRun({
      mode: 1,
      totalMs: run.splitMs, // RAW gate-clock interval (g1→g2)
      split1Ms: 0,
      split2Ms: 0,
      rawJson: JSON.stringify({
        engine: 'v2',
        startUs: run.startUs,
        finishUs: run.finishUs,
        splitMs: run.splitMs,
        synced: run.synced,
      }),
      status: 'valid',
      athleteId: who?.id ?? null, // null = Unassigned; assignable later in History
      drillType: dr,
    })
      .then(() => {
        setDbg(`saved ${fmt(run.splitMs, 3)}s ✓`);
        // Advance only after the run is COMMITTED. When the discard window lands
        // this call moves to the point the window closes, so a discarded run
        // leaves the cursor untouched.
        roster.completeRun();
      })
      .catch((e) => setDbg(`SAVE FAILED: ${String(e)}`));
  }, [v2.lastRun, roster]);

  // Keep awake while armed or running.
  useEffect(() => {
    const busy = v2.engineState === 'armed' || v2.engineState === 'running';
    if (busy) activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    else deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
  }, [v2.engineState]);

  const connected = gate.status === 'connected';
  const armed = v2.engineState === 'armed';
  const isRunning = v2.engineState === 'running';
  const showResult = !!v2.lastRun && v2.lastRun.synced && v2.engineState === 'idle' && !isRunning;
  const result = showResult ? v2.lastRun : null;

  const doArm = useCallback(() => {
    setFinishedTags(null);
    setDbg('');
    setLiveMs(0); // clear the live counter's last frame — no ghost number while armed
    v2.arm();
  }, [v2]);

  // Cancel lands on idle with no result, where the timer falls back to liveMs —
  // zero it too, or a cancelled run leaves the same stale frame on screen.
  const doCancel = useCallback(() => {
    setLiveMs(0);
    v2.resetEngine();
  }, [v2]);

  const big = result ? fmt(result.splitMs, 3) : fmt(liveMs, isRunning ? 2 : 3);
  const finishedTagStr = finishedTags ? formatTags(finishedTags.name, finishedTags.drill) : '';

  return (
    <View style={styles.container}>
      <ConnChip />
      <View style={styles.setRow}>
        <SetControl />
      </View>
      <SessionLine />

      {/* Who this run is for + who follows. Tap to jump to anyone. */}
      <UpNextStrip />

      {/* Drill label only — the athlete comes from the roster queue above. */}
      <Pressable style={styles.tagBar} onPress={() => setTagOpen(true)}>
        <Text style={[styles.tagBarText, !drill && styles.tagBarPlaceholder]} numberOfLines={1}>
          {drill || '＋  Drill (optional)'}
        </Text>
        {drill ? (
          <Pressable onPress={() => applyTags('', '')} hitSlop={8}>
            <Text style={styles.tagClear}>✕</Text>
          </Pressable>
        ) : (
          <Text style={styles.tagSet}>Set</Text>
        )}
      </Pressable>

      <View style={styles.stage}>
        {armed ? <Text style={styles.phase}>Armed — run through the start gate</Text> : null}
        {isRunning ? <Text style={styles.phase}>Running…</Text> : null}
        <Text style={[styles.timer, result ? styles.timerDone : null]}>{big}</Text>
        <Text style={styles.unit}>seconds</Text>
        {result && finishedTagStr ? <Text style={styles.resultTags}>{finishedTagStr}</Text> : null}

        {result ? (
          <View style={styles.splits}>
            <Split label="Gate 1 → Gate 2" ms={result.splitMs} strong />
            <Text style={styles.note}>raw gate-clock interval · v2 engine</Text>
          </View>
        ) : null}

        {result ? (
          <Pressable
            onPress={() =>
              shareText(runShareLine(finishedTags?.name, finishedTags?.drill, result.splitMs))
            }
            style={({ pressed }) => [styles.shareBtn, pressed && styles.dim]}
          >
            <Text style={styles.shareBtnText}>⤴  Share</Text>
          </Pressable>
        ) : null}

        <Text style={styles.hint}>{hintFor(connected, v2.phase, v2.engineState, !!result)}</Text>
        {dbg ? <Text style={styles.dbg}>{dbg}</Text> : null}
      </View>

      <View style={styles.controls}>
        {!armed && !isRunning ? (
          <Btn
            label={result ? 'Run again' : 'Arm (Mode 1)'}
            onPress={doArm}
            disabled={!v2.ready}
            kind="go"
          />
        ) : (
          <Btn label="Cancel" onPress={doCancel} kind="warn" />
        )}
      </View>

      {/* Drill only — athlete selection lives in the strip's roster picker. */}
      <TagPickerModal
        visible={tagOpen}
        title="Drill"
        initialName=""
        initialDrill={drill}
        recents={[]}
        onClose={() => setTagOpen(false)}
        onSubmit={applyTags}
      />
    </View>
  );
}

function hintFor(
  connected: boolean,
  phase: string,
  engineState: string,
  hasResult: boolean,
): string {
  if (!connected) return 'Not connected — tap Connect above.';
  if (phase === 'partial')
    return 'Only one gate found — power the other gate (it will join automatically), or use Debug → v2 Lab for recovery.';
  if (phase !== 'ready') return `Setting up gates… (${phase})`;
  if (engineState === 'armed') return 'Waiting for the first beam break…';
  if (engineState === 'running') return 'Running — cross the finish gate.';
  if (hasResult) return 'Saved — tap Run again for the next rep.';
  return 'Tap Arm to start a Mode-1 rep.';
}

function SessionLine() {
  const v2 = useV2();
  const gate = useGate();
  if (gate.status !== 'connected') return null;
  const synced = v2.gates.filter((g) => g.timeSynced).length;
  const total = v2.gates.length;
  const ready = v2.phase === 'ready';
  // (The controlled SET is shown prominently by <SetControl /> above.)
  return (
    <View style={styles.sessionRow}>
      <View style={[styles.sdot, ready ? styles.sdotOn : styles.sdotBusy]} />
      <Text style={styles.sessionText}>
        v2 · {v2.phase === 'partial' ? '1 gate (recovery)' : v2.phase}
        {total ? ` · ${synced}/${total} synced` : ''}
        {v2.ping ? ` · ping ${v2.ping.rttMs.toFixed(0)}ms` : ''}
      </Text>
      {!ready ? (
        <Pressable onPress={v2.bringUp} hitSlop={8}>
          <Text style={styles.sessionAction}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function ConnChip() {
  const gate = useGate();
  const s = gate.status;
  const label =
    s === 'connected'
      ? 'Gate connected'
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

function Split({ label, ms, strong }: { label: string; ms: number; strong?: boolean }) {
  return (
    <View style={styles.splitRow}>
      <Text style={[styles.splitLabel, strong && styles.splitStrong]}>{label}</Text>
      <Text style={[styles.splitVal, strong && styles.splitStrong]}>{fmt(ms, 3)}s</Text>
    </View>
  );
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
  setRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4 },
  sessionRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingBottom: 6 },
  sdot: { width: 8, height: 8, borderRadius: 4 },
  sdotOn: { backgroundColor: '#22c55e' },
  sdotBusy: { backgroundColor: '#f59e0b' },
  sessionText: { color: '#8b98a9', fontSize: 12, flex: 1 },
  sessionAction: { color: '#60a5fa', fontWeight: '700', fontSize: 12 },
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
  phase: { color: '#fbbf24', fontSize: 20, fontWeight: '700', marginBottom: 8 },
  timer: { color: '#fff', fontSize: 76, fontWeight: '800', fontVariant: ['tabular-nums'] },
  timerDone: { color: '#34d399' },
  unit: { color: '#64748b', fontSize: 14, marginTop: -6 },
  splits: { marginTop: 20, width: '70%', alignItems: 'center' },
  splitRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4, width: '100%' },
  splitLabel: { color: '#94a3b8', fontSize: 15 },
  splitVal: { color: '#e2e8f0', fontSize: 15, fontVariant: ['tabular-nums'] },
  splitStrong: { color: '#fff', fontWeight: '800' },
  note: { color: '#64748b', fontSize: 11, marginTop: 6, textAlign: 'center' },
  shareBtn: {
    marginTop: 18,
    backgroundColor: '#1f2937',
    borderRadius: 999,
    paddingHorizontal: 20,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: '#374151',
  },
  shareBtnText: { color: '#e2e8f0', fontSize: 14, fontWeight: '700' },
  hint: { color: '#64748b', fontSize: 13, marginTop: 24, textAlign: 'center' },
  dbg: { color: '#475569', fontSize: 11, marginTop: 8, textAlign: 'center', fontVariant: ['tabular-nums'] },
  controls: { paddingBottom: 12 },
  btn: { backgroundColor: '#2563eb', paddingVertical: 16, borderRadius: 12, alignItems: 'center' },
  btnGo: { backgroundColor: '#16a34a' },
  btnWarn: { backgroundColor: '#b4541f' },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  dim: { opacity: 0.4 },
});
