// Dev-only v2 acceptance-test surface (docs/BLE-CONTRACT.md §14). Runs the raw
// v2 pipeline alongside the live v1 gate result and shows the per-run agreement.
// Green Δ = within the ±5 ms TF-Luna quantization band → cut-over signal.

import { FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { useV2Pipeline, type Comparison } from '../ble/useV2';

const AGREE_MS = 5; // TF-Luna 250 Hz frame quantization band (§14)
const WARN_MS = 10;

export default function V2Lab() {
  const p = useV2Pipeline();

  const agree = p.comparisons.filter((c) => c.synced && Math.abs(c.deltaMs) <= AGREE_MS).length;
  const synced = p.comparisons.filter((c) => c.synced).length;

  return (
    <View style={styles.wrap}>
      <Text style={styles.h1}>v2 raw-pipeline lab</Text>
      <Text style={styles.sub}>
        engine: {p.engineState}
        {p.ping ? `  ·  ping ${p.ping.rttMs.toFixed(1)}ms` : ''}
        {p.comparisons.length ? `  ·  agree ${agree}/${synced} synced` : ''}
      </Text>

      {/* Discovered gates + their assigned id / sync state */}
      <Text style={styles.section}>gates</Text>
      {p.discovered.length === 0 ? (
        <Text style={styles.muted}>no heartbeats yet… connect and wait ~1s</Text>
      ) : (
        p.discovered.map((g) => {
          const st = p.statuses.find((s) => s.gateId === g.gateId);
          return (
            <View key={g.mac} style={styles.gateRow}>
              <Text style={styles.mono}>{g.mac}</Text>
              <Text style={styles.gateMeta}>
                id {g.gateId ?? '—'}
                {st ? `  ·  ${st.timeSynced ? 'synced' : 'UNSYNCED'}  ·  ${st.thresholdCm}cm  ·  q${st.queueDepth}` : ''}
              </Text>
            </View>
          );
        })
      )}

      {/* Workflow */}
      <View style={styles.row}>
        <Btn label="1· Assign IDs" onPress={p.assignIds} disabled={!p.connected || !!p.busy} />
        <Btn label="2· Get status" onPress={p.getStatus} disabled={!p.connected || !!p.busy} />
      </View>
      <View style={styles.row}>
        <Btn label="Ping/offset" onPress={p.pingSync} disabled={!p.connected || !!p.busy} />
        <Btn label="Clear queue" onPress={p.clearQueue} disabled={!p.connected || !!p.busy} />
      </View>
      <View style={styles.row}>
        <Btn label="3· Arm run (M1)" onPress={p.armRun} disabled={!p.connected || !!p.busy} kind="go" />
        <Btn label="Reset engine" onPress={p.resetEngine} disabled={!p.connected} />
      </View>

      {/* Comparison table */}
      <View style={styles.cmpHead}>
        <Text style={styles.cmpTitle}>v1 vs v2 split  (Δ = v2 − v1)</Text>
        {p.comparisons.length ? (
          <Pressable onPress={p.clearComparisons}>
            <Text style={styles.clear}>clear</Text>
          </Pressable>
        ) : null}
      </View>
      <View style={[styles.cmpRow, styles.cmpRowHead]}>
        <Text style={[styles.cell, styles.cellHead]}>#</Text>
        <Text style={[styles.cell, styles.cellHead]}>v1 (ms)</Text>
        <Text style={[styles.cell, styles.cellHead]}>v2 (ms)</Text>
        <Text style={[styles.cell, styles.cellHead]}>Δ (ms)</Text>
      </View>
      <FlatList
        style={styles.cmpList}
        data={p.comparisons}
        keyExtractor={(c) => c.id}
        ListEmptyComponent={
          <Text style={styles.muted}>
            arm a Mode-1 rep and run both gates — the v1 result and v2 split land here paired.
          </Text>
        }
        renderItem={({ item }) => <CmpRow c={item} />}
      />

      <Text style={styles.section}>v2 event log</Text>
      <FlatList
        style={styles.log}
        data={p.log}
        keyExtractor={(_l, i) => `${i}`}
        renderItem={({ item }) => <Text style={styles.logLine}>{item}</Text>}
      />
    </View>
  );
}

function CmpRow({ c }: { c: Comparison }) {
  const abs = Math.abs(c.deltaMs);
  const color = !c.synced ? '#8b98a9' : abs <= AGREE_MS ? '#4ade80' : abs <= WARN_MS ? '#fbbf24' : '#f87171';
  return (
    <View style={styles.cmpRow}>
      <Text style={styles.cell}>{c.id}</Text>
      <Text style={styles.cell}>{c.v1Ms}</Text>
      <Text style={styles.cell}>{c.synced ? c.v2Ms : '—'}</Text>
      <Text style={[styles.cell, { color, fontWeight: '700' }]}>
        {c.synced ? (c.deltaMs > 0 ? `+${c.deltaMs}` : `${c.deltaMs}`) : 'unsync'}
      </Text>
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
  kind?: 'go';
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.btn,
        kind === 'go' && styles.btnGo,
        (disabled || pressed) && styles.dim,
      ]}
    >
      <Text style={styles.btnText}>{label}</Text>
    </Pressable>
  );
}

const mono = Platform.OS === 'ios' ? 'Menlo' : 'monospace';
const styles = StyleSheet.create({
  wrap: { flex: 1 },
  h1: { color: '#fff', fontSize: 18, fontWeight: '800' },
  sub: { color: '#8b98a9', marginTop: 2, marginBottom: 8, fontSize: 12 },
  section: { color: '#8b98a9', fontWeight: '700', marginTop: 8, marginBottom: 4, fontSize: 12 },
  muted: { color: '#64748b', fontSize: 12, paddingVertical: 6 },
  gateRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  mono: { color: '#cbd5e1', fontFamily: mono, fontSize: 12 },
  gateMeta: { color: '#93c5fd', fontSize: 12 },
  row: { flexDirection: 'row', gap: 8, marginTop: 8 },
  btn: { flex: 1, backgroundColor: '#2563eb', paddingVertical: 11, borderRadius: 10, alignItems: 'center' },
  btnGo: { backgroundColor: '#16a34a' },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  dim: { opacity: 0.4 },
  cmpHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 },
  cmpTitle: { color: '#e2e8f0', fontWeight: '700', fontSize: 13 },
  clear: { color: '#f87171', fontSize: 12 },
  cmpRow: { flexDirection: 'row', paddingVertical: 5, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#1f2733' },
  cmpRowHead: { borderBottomColor: '#334155' },
  cell: { flex: 1, color: '#e2e8f0', fontFamily: mono, fontSize: 13, fontVariant: ['tabular-nums'] },
  cellHead: { color: '#64748b', fontSize: 11, fontWeight: '700' },
  cmpList: { maxHeight: 150 },
  log: { flex: 1, backgroundColor: '#06080c', borderRadius: 8, padding: 8, marginTop: 4 },
  logLine: { color: '#9fe6a0', fontFamily: mono, fontSize: 11, marginBottom: 2 },
});
