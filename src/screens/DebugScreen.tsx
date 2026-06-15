// Diagnostics. Rides on the shared GateProvider connection. Shows a per-type
// event tally, the live gate Status, and — crucially — "gate runs" (from the
// reliable Status read) next to "FINISH events seen". If runs climbs but FINISH
// does not, the FINISH *notification* is being dropped (delivery, not parsing).

import { useEffect, useRef, useState } from 'react';
import { FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { useGate } from '../ble/GateProvider';
import { EVT_NAME, STATE_NAME } from '../ble/constants';
import { describeEvent, toHex } from '../ble/decode';

type LogLine = { id: string; text: string; kind: 'evt' | 'status' };
let logSeq = 0;

export default function DebugScreen() {
  const gate = useGate();
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
      <Text style={styles.title}>Diagnostics</Text>
      <Text style={styles.subtitle}>
        adapter {gate.adapterOn ? 'on' : 'off'} · {gate.status}
        {gate.gateStatus ? ` · proto ${gate.gateStatus.protoVer}` : ''}
      </Text>

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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0e1116', paddingTop: 56, paddingHorizontal: 16 },
  title: { color: '#fff', fontSize: 22, fontWeight: '800' },
  subtitle: { color: '#8b98a9', marginTop: 4, marginBottom: 10 },
  cards: { flexDirection: 'row', gap: 10, marginBottom: 6 },
  card: { flex: 1, backgroundColor: '#161b22', borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  cardWarn: { backgroundColor: '#3b1d1d', borderWidth: 1, borderColor: '#b4541f' },
  cardNum: { color: '#fff', fontSize: 28, fontWeight: '800', fontVariant: ['tabular-nums'] },
  cardLabel: { color: '#8b98a9', fontSize: 12, marginTop: 2 },
  warn: { color: '#fb923c', fontSize: 12, marginBottom: 6 },
  tally: {
    color: '#9fe6a0',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 11,
    marginBottom: 10,
  },
  row: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  btn: { flex: 1, backgroundColor: '#2563eb', paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
  btnWarn: { backgroundColor: '#b4541f' },
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
});
