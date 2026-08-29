// Diagnostics. Rides on the shared GateProvider connection. Shows a per-type
// event tally, the live gate Status, and — crucially — "gate runs" (from the
// reliable Status read) next to "FINISH events seen". If runs climbs but FINISH
// does not, the FINISH *notification* is being dropped (delivery, not parsing).

import { useEffect, useRef, useState } from 'react';
import { Alert, FlatList, Platform, Pressable, Share, StyleSheet, Text, View } from 'react-native';

import { readLog } from '../diag/crashlog';

import { useGate } from '../ble/GateProvider';
import { useV2 } from '../ble/V2Provider';
import { EVT_NAME, STATE_NAME } from '../ble/constants';
import { describeEvent, toHex } from '../ble/decode';
import V2Lab from '../components/V2Lab';
import { PruneTestDataModal } from '../components/PruneTestData';
import {
  CAUTION,
  DESTRUCTIVE,
  DESTRUCTIVE_EDGE,
  INTERACTIVE,
} from '../theme';

type LogLine = { id: string; text: string; kind: 'evt' | 'status' };
let logSeq = 0;

/**
 * Hand the event log to the share sheet, or say there is nothing in it.
 *
 * Shared as TEXT rather than written to a file first: it is a few kilobytes, and a
 * second copy on disk is one more thing to clean up on a phone whose storage this
 * app already guards.
 */
async function shareEventLog(): Promise<void> {
  const text = readLog();
  if (!text.trim()) {
    Alert.alert('Nothing logged', 'The event log is empty. It fills as the app runs.');
    return;
  }
  try {
    await Share.share({ message: text });
  } catch (e) {
    Alert.alert('Could not share the log', String(e));
  }
}

export default function DebugScreen({ onBack }: { onBack?: () => void }) {
  const gate = useGate();
  const [view, setView] = useState<'diag' | 'v2'>('diag');
  const [pruneOpen, setPruneOpen] = useState(false);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const lastStatusRef = useRef('');

  const addLog = (text: string, kind: 'evt' | 'status') => {
    const stamp = new Date().toLocaleTimeString();
    setLogs((prev) => [{ id: `${++logSeq}`, text: `${stamp}  ${text}`, kind }, ...prev].slice(0, 250));
  };

  // Event notifications.
  useEffect(() => {
    const off = gate.subscribe((raw) => {
      const name = EVT_NAME[raw[0]] ?? `0x${raw[0]?.toString(16)}`;
      setCounts((c) => ({ ...c, [name]: (c[name] ?? 0) + 1 }));
      addLog(`<- ${describeEvent(raw)}   [${toHex(raw)}]`, 'evt');
    });
    return off;
  }, [gate]);

  // Status updates (from notifications or the Timer screen's poll).
  useEffect(() => {
    const s = gate.gateStatus;
    if (!s) return;
    const key = `${s.state}/${s.mode}/${s.runCount}/${s.finishLinkOk}`;
    if (key === lastStatusRef.current) return; // ignore gateMicros-only churn
    lastStatusRef.current = key;
    addLog(
      `STATUS state=${STATE_NAME[s.state] ?? s.state} mode=${s.mode} runs=${s.runCount} finishLink=${s.finishLinkOk ? 'OK' : 'DOWN'}`,
      'status',
    );
  }, [gate.gateStatus]);

  const connected = gate.status === 'connected';
  const finishSeen = counts.FINISH ?? 0;
  const gateRuns = gate.gateStatus?.runCount ?? 0;
  const dropWarn = gateRuns > finishSeen;

  return (
    <View style={styles.container}>
      {onBack ? (
        <Pressable onPress={onBack} hitSlop={10} style={styles.backRow}>
          <Text style={styles.backText}>‹  Settings</Text>
        </Pressable>
      ) : null}
      <View style={styles.titleRow}>
        <View style={styles.titleCol}>
          <Text style={styles.title}>Diagnostics</Text>
          <Text style={styles.subtitle}>
            adapter {gate.adapterOn ? 'on' : 'off'} · {gate.status}
            {gate.gateStatus ? ` · proto ${gate.gateStatus.protoVer}` : ''}
          </Text>
        </View>
        {/* One-time maintenance, dev-mode only. Not a "clear history" button —
            it shows the distribution, then a count, before it can delete. */}
        {/* GETTING THE LOG OFF THE PHONE. The events that explain a crash are
            written to a file that outlives the process; this is the only way to
            read them without a Mac and a cable, which is the situation the last
            crash was diagnosed in — badly, from three guesses and no evidence. */}
        <Pressable
          onPress={() => void shareEventLog()}
          hitSlop={8}
          style={({ pressed }) => [styles.pruneBtn, pressed && { opacity: 0.5 }]}
        >
          <Text style={styles.pruneBtnText}>Share log</Text>
        </Pressable>
        <Pressable
          onPress={() => setPruneOpen(true)}
          hitSlop={8}
          style={({ pressed }) => [styles.pruneBtn, pressed && { opacity: 0.5 }]}
        >
          <Text style={styles.pruneBtnText}>Prune data</Text>
        </Pressable>
      </View>

      <PruneTestDataModal visible={pruneOpen} onClose={() => setPruneOpen(false)} />

      <RepeatDiagPanel />

      <View style={styles.seg}>
        <Pressable
          style={[styles.segBtn, view === 'diag' && styles.segOn]}
          onPress={() => setView('diag')}
        >
          <Text style={[styles.segText, view === 'diag' && styles.segTextOn]}>Diagnostics</Text>
        </Pressable>
        <Pressable
          style={[styles.segBtn, view === 'v2' && styles.segOn]}
          onPress={() => setView('v2')}
        >
          <Text style={[styles.segText, view === 'v2' && styles.segTextOn]}>v2 Lab</Text>
        </Pressable>
      </View>

      {view === 'v2' ? (
        <V2Lab />
      ) : (
        <>
      <View style={styles.cards}>
        <View style={styles.card}>
          <Text style={styles.cardNum}>{gateRuns}</Text>
          <Text style={styles.cardLabel}>gate runs (Status)</Text>
        </View>
        <View style={[styles.card, dropWarn && styles.cardWarn]}>
          <Text style={styles.cardNum}>{finishSeen}</Text>
          <Text style={styles.cardLabel}>FINISH events seen</Text>
        </View>
      </View>
      {dropWarn ? (
        <Text style={styles.warn}>
          ⚠ gate finished more runs than FINISH events arrived — FINISH notifications are dropping.
        </Text>
      ) : null}

      <Text style={styles.tally}>
        {['STATE', 'COUNTDOWN', 'GO', 'START', 'SPLIT', 'FINISH', 'NOTICE']
          .map((n) => `${n}:${counts[n] ?? 0}`)
          .join('  ')}
      </Text>

      {!connected ? (
        <>
          <Row>
            <Btn
              label={gate.status === 'scanning' ? 'Scanning…' : 'Scan'}
              onPress={gate.scan}
              disabled={!gate.adapterOn || gate.status === 'scanning'}
            />
          </Row>
          {gate.devices.map((d) => (
            <Btn key={d.id} label={`Connect → ${d.name ?? d.id}`} onPress={() => gate.connectTo(d)} />
          ))}
        </>
      ) : (
        <>
          <Row>
            <Btn label="Arm M1" onPress={gate.arm1} />
            <Btn label="Arm M2" onPress={gate.arm2} />
          </Row>
          <Row>
            <Btn label="Start seq" onPress={() => gate.startSequence()} />
            <Btn label="Go now" onPress={gate.goNow} />
          </Row>
          <Row>
            <Btn label="Reset" onPress={gate.reset} />
            <Btn label="Disconnect" onPress={gate.disconnect} kind="warn" />
          </Row>
        </>
      )}

      <Text style={styles.logHeader}>Event / status log (newest first)</Text>
      <FlatList
        style={styles.log}
        data={logs}
        keyExtractor={(l) => l.id}
        renderItem={({ item }) => (
          <Text style={[styles.logLine, item.kind === 'status' && styles.logStatus]}>{item.text}</Text>
        )}
      />
        </>
      )}
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
  kind?: 'warn';
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.btn,
        kind === 'warn' && styles.btnWarn,
        (disabled || pressed) && styles.dim,
      ]}
    >
      <Text style={styles.btnText}>{label}</Text>
    </Pressable>
  );
}

/**
 * Rep-set frame accounting. Answers, without guessing, whether frames are not
 * ARRIVING or are arriving and being REJECTED — and which rejection.
 *
 *   beam 0                      -> nothing is reaching the engine at all
 *   beam climbing, accepted 0   -> arriving and rejected; read the reason counters
 *   lastReject hugely negative  -> CLOCK MISMATCH, not a lockout that is too long
 */
function RepeatDiagPanel() {
  const v2 = useV2();
  const d = v2.repeatDiag;
  const suspectClock = d.lastRejectMs != null && d.lastRejectMs < -60000;
  return (
    <View style={styles.diagWrap}>
      <Text style={styles.diagTitle}>REP SETS — FRAME ACCOUNTING ({v2.repeatState})</Text>
      <Text style={styles.diagLine}>
        beam {d.beam} · opened {d.opened} · accepted {d.accepted}
      </Text>
      <Text style={styles.diagLine}>
        rejected: clears {d.clears} · otherGate {d.otherGate} · notRunning {d.notRunning} ·
        lockedOut {d.lockedOut}
      </Text>
      <Text style={[styles.diagLine, suspectClock && styles.diagAlert]}>
        lastReject {d.lastRejectMs == null ? '—' : `${d.lastRejectMs}ms`}
        {suspectClock ? '   ← CLOCK MISMATCH, not the lockout' : ''}
      </Text>
      {d.beam === 0 ? (
        <Text style={styles.diagHint}>No beam frames seen — not an engine problem.</Text>
      ) : d.accepted === 0 ? (
        <Text style={styles.diagHint}>
          Frames ARE arriving and being rejected. The counter above that is climbing says why.
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  diagWrap: {
    marginTop: 12,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#243042',
    backgroundColor: '#0b0e13',
  },
  diagTitle: { color: '#64748b', fontSize: 10, fontWeight: '800', letterSpacing: 0.6 },
  diagLine: { color: '#94a3b8', fontSize: 12, marginTop: 4, fontVariant: ['tabular-nums'] },
  diagAlert: { color: CAUTION, fontWeight: '800' },
  diagHint: { color: CAUTION, fontSize: 11, marginTop: 6, lineHeight: 15 },
  container: { flex: 1, backgroundColor: '#0e1116', paddingTop: 56, paddingHorizontal: 16 },
  backRow: { paddingBottom: 6 },
  backText: { color: INTERACTIVE, fontSize: 15, fontWeight: '700' },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  titleCol: { flex: 1, minWidth: 0 },
  title: { color: '#fff', fontSize: 22, fontWeight: '800' },
  subtitle: { color: '#8b98a9', marginTop: 4, marginBottom: 10 },
  pruneBtn: {
    marginTop: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#7f1d1d',
    backgroundColor: '#1a1214',
  },
  pruneBtnText: { color: DESTRUCTIVE, fontSize: 12, fontWeight: '800' },
  cards: { flexDirection: 'row', gap: 10, marginBottom: 6 },
  card: { flex: 1, backgroundColor: '#161b22', borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  cardWarn: { backgroundColor: '#3b1d1d', borderWidth: 1, borderColor: DESTRUCTIVE_EDGE },
  cardNum: { color: '#fff', fontSize: 28, fontWeight: '800', fontVariant: ['tabular-nums'] },
  cardLabel: { color: '#8b98a9', fontSize: 12, marginTop: 2 },
  warn: { color: CAUTION, fontSize: 12, marginBottom: 6 },
  tally: {
    color: '#9fe6a0',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 11,
    marginBottom: 10,
  },
  row: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  btn: { flex: 1, backgroundColor: '#2563eb', paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
  btnWarn: { backgroundColor: DESTRUCTIVE_EDGE },
  btnText: { color: '#fff', fontWeight: '600' },
  dim: { opacity: 0.4 },
  logHeader: { color: '#8b98a9', marginTop: 4, marginBottom: 4, fontWeight: '600' },
  log: { flex: 1, backgroundColor: '#06080c', borderRadius: 8, padding: 8 },
  logLine: {
    color: '#9fe6a0',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 11,
    marginBottom: 2,
  },
  logStatus: { color: '#7dd3fc' },
  seg: { flexDirection: 'row', backgroundColor: '#161b22', borderRadius: 10, padding: 3, marginBottom: 10 },
  segBtn: { flex: 1, paddingVertical: 7, borderRadius: 8, alignItems: 'center' },
  segOn: { backgroundColor: '#2563eb' },
  segText: { color: '#8b98a9', fontWeight: '700', fontSize: 13 },
  segTextOn: { color: '#fff' },
});
