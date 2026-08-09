// Event drills, on the v2 raw-event engine (docs/DRILLS.md). One parameterized
// engine, two presets (L Drill, Shuttle Run). Start is a CLEAR on the start gate
// (athlete leaves the beam); then a lockout-gated count of breaks on the count
// gate stops it. The lockout is tuned LIVE here (steppers) against real athletes,
// persisted per drill. Each finish saves to the same SQLite history as Mode 1,
// tagged with the drill label.
//
// Runs off the shared V2Provider session (auto discover/assign/sync) — the SAME
// bring-up as the Mode-1 Timer, so a drill needs both gates powered and READY
// even when it only uses one beam (the shuttle): reusing the proven 2-gate path
// is far less risky the night before an event than a bespoke single-gate arm.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

import { useGate } from '../ble/GateProvider';
import { useV2 } from '../ble/V2Provider';
import {
  DRILLS,
  DRILL_MODE,
  clampLockout,
  LOCKOUT_BOUNDS,
  type DrillConfig,
} from '../ble/drills';
import { getSetting, saveRun, setSetting } from '../db/database';
import { formatTags } from '../runs/format';
import { SetControl } from '../components/SetControl';
import { UpNextStrip } from '../components/UpNextStrip';
import { DiscardBar } from '../components/DiscardBar';
import { resolveKey } from '../ble/catalog';
import { useRoster } from '../roster/RosterProvider';
import { usePendingRun } from '../runs/PendingRunProvider';
import { runShareLine, shareText } from '../share';

const KEEP_AWAKE_TAG = 'equalsplit-drill';
const nowMs = () =>
  typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now();
const fmt = (ms: number, dec: number) => (Math.max(0, ms) / 1000).toFixed(dec);
const secs = (ms: number) => (ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1);
const lockoutKey = (drillKey: string) => `drill_lockout_${drillKey}_ms`;

/**
 * @param selectedKey Optional. When the host (DrillsTab) owns drill selection,
 *   it passes the key and this screen hides its own picker and tightens its top
 *   padding to sit under the host's header. ABSENT = unchanged behaviour: own
 *   state, own picker, own full-screen padding. resolveKey() is the fallback,
 *   verified exhaustively by scripts/verify-catalog.mjs block 1.
 *
 * Nothing below the picker knows this prop exists — arming, cancel, lockout
 * persistence, the save effect and the result view are untouched.
 */
export default function DrillsScreen({ selectedKey, header }: { selectedKey?: string; header?: React.ReactNode } = {}) {
  const v2 = useV2();
  const gate = useGate();

  // Retain the v2 session while mounted (ref-counted with Timer/Lab).
  useEffect(() => {
    v2.retain();
    return v2.release;
  }, [v2.retain, v2.release]);

  // Own state is the fallback, never removed — with no selectedKey this is
  // exactly the previous behaviour.
  const [ownKey, setOwnKey] = useState<string>(DRILLS[0].key);
  const drillKey = resolveKey(selectedKey, ownKey);
  const base = useMemo(() => DRILLS.find((d) => d.key === drillKey) ?? DRILLS[0], [drillKey]);
  const [lockoutMs, setLockoutMs] = useState<number>(base.lockoutMs);
  const config: DrillConfig = useMemo(() => ({ ...base, lockoutMs }), [base, lockoutMs]);

  const roster = useRoster();
  const [liveMs, setLiveMs] = useState(0);
  const [dbg, setDbg] = useState('');
  const [finishedTags, setFinishedTags] = useState<{ name: string; drill: string } | null>(null);

  // Attribution comes from the roster queue; ref so the save effect reads
  // whoever was up at the moment the rep landed.
  const currentAthleteRef = useRef(roster.currentAthlete);
  currentAthleteRef.current = roster.currentAthlete;
  // Same reason: the save effect must offer the discard window for the run that
  // just landed, without this provider's identity churning its dependencies.
  const pending = usePendingRun();
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const t0Ref = useRef(0);
  const savedRef = useRef<unknown>(null);
  // On drill switch: load the persisted (tuned) lockout for that drill.
  useEffect(() => {
    (async () => {
      try {
        const v = await getSetting(lockoutKey(base.key));
        const n = v == null ? base.lockoutMs : parseInt(v, 10);
        setLockoutMs(clampLockout(base.key, Number.isFinite(n) ? n : base.lockoutMs));
      } catch {
        setLockoutMs(base.lockoutMs);
      }
    })();
  }, [base]);

  // The effective config (with the live-tuned lockout) is captured at ARM by
  // armDrill(config) — deliberately NOT pushed into the engine continuously, so
  // nudging the lockout during a run can't change that run; it applies next arm.
  // Both drills start on gate 1, so the engine's default config already tracks
  // the correct start beam before the first arm.

  const adjustLockout = useCallback(
    (deltaMs: number) => {
      setLockoutMs((prev) => {
        const next = clampLockout(base.key, prev + deltaMs);
        setSetting(lockoutKey(base.key), String(next)).catch(() => {});
        return next;
      });
    },
    [base.key],
  );

  // Live running timer: t0 = start CLEAR mapped to phone time (fallback: arrival).
  useEffect(() => {
    if (!v2.drillRunning) return undefined;
    const startPhone = v2.gateToPhoneMs(v2.drillRunning.startUs) ?? v2.drillRunning.startAtMs;
    t0Ref.current = startPhone;
    setLiveMs(Math.max(0, nowMs() - startPhone));
    const id = setInterval(() => setLiveMs(Math.max(0, nowMs() - t0Ref.current)), 33);
    return () => clearInterval(id);
  }, [v2.drillRunning, v2.gateToPhoneMs]);

  // Save each finished drill run. Withhold (don't save) an unsynced L-drill (two
  // gates, cross-clock); the shuttle is single-gate so always synced.
  useEffect(() => {
    const run = v2.lastDrillRun;
    if (!run || savedRef.current === run) return;
    savedRef.current = run;
    if (!run.synced) {
      setDbg('gates not time-synced — result withheld (not saved)');
      return;
    }
    const who = currentAthleteRef.current;
    // The drill IS the engine's, always — a free-text override here would mint
    // manual drill records for engine runs and split them out of the graphs.
    const dr = run.label;
    setFinishedTags({ name: who?.display_name ?? '', drill: dr });
    saveRun({
      mode: DRILL_MODE,
      totalMs: run.splitMs, // raw gate-clock interval
      split1Ms: 0,
      split2Ms: 0,
      rawJson: JSON.stringify({
        engine: 'drill',
        key: run.configKey,
        label: run.label,
        counted: run.counted,
        countN: run.countN,
        lockoutMs: run.lockoutMs,
        startUs: run.startUs,
        finishUs: run.finishUs,
        synced: run.synced,
      }),
      status: 'valid',
      athleteId: who?.id ?? null, // null = Unassigned; assignable later in History
      drillType: dr,
    })
      .then((runId) => {
        setDbg(`saved ${fmt(run.splitMs, 3)}s ✓`);
        // Advance only once the rep is COMMITTED (see TimerV2Screen).
        roster.completeRun();
        // Open the discard window on this rep. It stays open until the next one
        // is armed — see doArm.
        pendingRef.current.offerRun({
          runId,
          totalMs: run.splitMs,
          athleteName: who?.display_name ?? null,
          drillName: dr,
          standalone: false,
          savedAt: Date.now(),
        });
      })
      .catch((e) => setDbg(`SAVE FAILED: ${String(e)}`));
  }, [v2.lastDrillRun, roster]);

  // Keep awake while a drill is armed/set/running.
  useEffect(() => {
    const busy = v2.drillState !== 'idle';
    if (busy) activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    else deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
  }, [v2.drillState]);

  const connected = gate.status === 'connected';
  const idle = v2.drillState === 'idle';
  const running = v2.drillState === 'running';
  const showResult = !!v2.lastDrillRun && v2.lastDrillRun.synced && idle && !running;
  const result = showResult ? v2.lastDrillRun : null;

  const doArm = useCallback(() => {
    setFinishedTags(null);
    setDbg('');
    setLiveMs(0);
    // The next rep is starting, so the previous run settles — kept, not deleted.
    pending.settleForNextRep();
    v2.armDrill(config);
  }, [v2, config, pending]);

  const doCancel = useCallback(() => {
    setLiveMs(0);
    v2.cancelDrill();
  }, [v2]);

  const big = result ? fmt(result.splitMs, 3) : fmt(liveMs, running ? 2 : 3);
  const bounds = LOCKOUT_BOUNDS[base.key];

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, selectedKey != null && styles.contentEmbedded]}
      keyboardShouldPersistTaps="handled"
    >
      <ConnChip />
      {/* Hosted: the SetControl is PINNED by DrillsTab above the scroll, and
          `header` (the drill dropdown) scrolls with the content. Standalone: the
          screen keeps its own inline SetControl exactly as before. */}
      {selectedKey == null ? (
        <View style={styles.setRow}>
          <SetControl />
        </View>
      ) : null}
      {header}
      <SessionLine />

      {/* Who this rep is for + who follows. Tap to jump to anyone. */}
      <UpNextStrip />

      {/* Stays until the next rep is armed. Discard deletes; Keep settles it. */}
      <DiscardBar />

      {/* Drill picker — hidden when the host owns selection, or the same drill
          would be listed twice on one screen. */}
      {selectedKey == null ? (
      <View style={styles.pickRow}>
        {DRILLS.map((d) => (
          <Pressable
            key={d.key}
            onPress={() => setOwnKey(d.key)}
            disabled={!idle}
            style={({ pressed }) => [
              styles.pick,
              d.key === drillKey && styles.pickActive,
              (!idle || pressed) && d.key !== drillKey && styles.dim,
            ]}
          >
            <Text style={[styles.pickText, d.key === drillKey && styles.pickTextActive]}>
              {d.label}
            </Text>
          </Pressable>
        ))}
      </View>
      ) : null}
      <Text style={styles.setup}>{setupLine(base)}</Text>

      {/* Live lockout tuning */}
      <View style={styles.tuneRow}>
        <Text style={styles.tuneLabel}>{lockoutLabel(base)}</Text>
        <View style={styles.tuneCtl}>
          <Stepper
            label="−"
            onPress={() => adjustLockout(-bounds.stepMs)}
            disabled={!idle || lockoutMs <= bounds.minMs}
          />
          <Text style={styles.tuneVal}>{secs(lockoutMs)}s</Text>
          <Stepper
            label="+"
            onPress={() => adjustLockout(bounds.stepMs)}
            disabled={!idle || lockoutMs >= bounds.maxMs}
          />
        </View>
      </View>

      <View style={styles.stage}>
        <Text style={styles.phase}>{phaseLine(v2.drillState)}</Text>
        <Text style={[styles.timer, result ? styles.timerDone : null]}>{big}</Text>
        <Text style={styles.unit}>seconds</Text>
        {running ? <Text style={styles.progress}>{progressLine(base, v2.drillProgress)}</Text> : null}
        {result && finishedTags ? (
          <Text style={styles.resultTags}>{formatTags(finishedTags.name, finishedTags.drill)}</Text>
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

        <Text style={styles.hint}>{hintFor(connected, v2.phase, v2.drillState, !!result, base)}</Text>
        {dbg ? <Text style={styles.dbg}>{dbg}</Text> : null}
      </View>

      <View style={styles.controls}>
        {idle ? (
          <Btn
            label={result ? 'Run again' : `Arm ${base.label}`}
            onPress={doArm}
            disabled={!v2.ready}
            kind="go"
          />
        ) : (
          <Btn label="Cancel" onPress={doCancel} kind="warn" />
        )}
      </View>
    </ScrollView>
  );
}

function setupLine(d: DrillConfig): string {
  if (d.startGateId === d.countGateId) {
    return `Gate ${d.startGateId} only · start when it clears · ${d.countN} pass${d.countN === 1 ? '' : 'es'} to stop`;
  }
  return `Gate ${d.startGateId} start (clear) → Gate ${d.countGateId} stop · ${d.countN} pass${d.countN === 1 ? '' : 'es'}`;
}

function lockoutLabel(d: DrillConfig): string {
  return d.countN > 1 ? 'Lockout between passes' : 'Grace before the stop pass';
}

function phaseLine(state: string): string {
  switch (state) {
    case 'armed':
      return 'Waiting — athlete into the start gate';
    case 'set':
      return 'Set — go when they leave the start gate';
    case 'running':
      return 'Running…';
    default:
      return '';
  }
}

function progressLine(d: DrillConfig, progress: { counted: number; countN: number } | null): string {
  if (d.countN <= 1) return 'waiting for the stop beam';
  const counted = progress?.counted ?? 0;
  return `pass ${counted} / ${d.countN}`;
}

function hintFor(
  connected: boolean,
  phase: string,
  state: string,
  hasResult: boolean,
  d: DrillConfig,
): string {
  if (!connected) return 'Not connected — tap Connect above.';
  if (phase === 'partial')
    return 'Only one gate found — power both gates of this set (a drill needs the session up).';
  if (phase !== 'ready') return `Setting up gates… (${phase})`;
  if (state === 'armed') return 'Have the athlete step into the start gate, hold still, then go.';
  if (state === 'set') return 'Timer starts the instant they leave the start gate.';
  if (state === 'running') return d.countN > 1 ? 'Counting passes…' : 'Waiting for the final pass…';
  if (hasResult) return 'Saved — tap Run again for the next rep.';
  return `Arm when the athlete is set at the start gate.`;
}

// --- shared small components (mirrors the Timer's chrome) -------------------

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
      </Text>
      {!ready ? (
        <Pressable onPress={v2.bringUp} hitSlop={8}>
          <Text style={styles.sessionAction}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function Stepper({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      style={({ pressed }) => [styles.stepper, (disabled || pressed) && styles.dim]}
    >
      <Text style={styles.stepperText}>{label}</Text>
    </Pressable>
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
  container: { flex: 1, backgroundColor: '#0e1116' },
  content: { paddingTop: 56, paddingHorizontal: 16, paddingBottom: 24 },
  /** Hosted under DrillsTab's header, which already clears the status bar. */
  contentEmbedded: { paddingTop: 6 },
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
  pickRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  pick: {
    flex: 1,
    backgroundColor: '#161b22',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#243042',
  },
  pickActive: { backgroundColor: '#1d4ed8', borderColor: '#3b82f6' },
  pickText: { color: '#94a3b8', fontWeight: '700', fontSize: 14 },
  pickTextActive: { color: '#fff' },
  setup: { color: '#8b98a9', fontSize: 12, marginTop: 8, textAlign: 'center' },
  tuneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#161b22',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginTop: 12,
    gap: 10,
  },
  tuneLabel: { color: '#cbd5e1', fontSize: 13, flex: 1 },
  tuneCtl: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  tuneVal: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '800',
    minWidth: 54,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  stepper: { backgroundColor: '#243042', borderRadius: 8, width: 40, paddingVertical: 8, alignItems: 'center' },
  stepperText: { color: '#e2e8f0', fontWeight: '800', fontSize: 18 },
  tagBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#161b22',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    marginTop: 10,
  },
  tagBarText: { color: '#e2e8f0', fontSize: 14, fontWeight: '600', flex: 1 },
  tagBarPlaceholder: { color: '#64748b', fontWeight: '400' },
  tagSet: { color: '#60a5fa', fontSize: 13, fontWeight: '700' },
  stage: { alignItems: 'center', justifyContent: 'center', paddingVertical: 24, minHeight: 260 },
  phase: { color: '#fbbf24', fontSize: 18, fontWeight: '700', marginBottom: 8, minHeight: 24, textAlign: 'center' },
  timer: { color: '#fff', fontSize: 72, fontWeight: '800', fontVariant: ['tabular-nums'] },
  timerDone: { color: '#34d399' },
  unit: { color: '#64748b', fontSize: 14, marginTop: -6 },
  progress: { color: '#93c5fd', fontSize: 16, fontWeight: '700', marginTop: 10, fontVariant: ['tabular-nums'] },
  resultTags: { color: '#94a3b8', fontSize: 15, fontWeight: '600', marginTop: 8 },
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
  hint: { color: '#64748b', fontSize: 13, marginTop: 20, textAlign: 'center', paddingHorizontal: 8 },
  dbg: { color: '#475569', fontSize: 11, marginTop: 8, textAlign: 'center', fontVariant: ['tabular-nums'] },
  controls: { paddingTop: 4 },
  btn: { backgroundColor: '#2563eb', paddingVertical: 16, borderRadius: 12, alignItems: 'center' },
  btnGo: { backgroundColor: '#16a34a' },
  btnWarn: { backgroundColor: '#b4541f' },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  dim: { opacity: 0.4 },
});
