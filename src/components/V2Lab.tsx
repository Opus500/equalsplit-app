// Dev-only v2 acceptance-test surface (docs/BLE-CONTRACT.md §14). Consumes the
// shared V2Provider session: it activates the pipeline on mount (auto bring-up:
// discover -> assign -> sync -> ping), then shows each rep's v1-vs-v2 agreement.
// Green Δ = within the ±5 ms TF-Luna quantization band → cut-over signal.

import { useEffect } from 'react';
import { FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { useV2, type Comparison } from '../ble/V2Provider';

const AGREE_MS = 5; // TF-Luna 250 Hz frame quantization band (§14)
const WARN_MS = 10;

export default function V2Lab() {
  const v2 = useV2();

  // Activate the v2 session while this view is mounted; go dormant on leave.
  useEffect(() => {
    v2.retain();
    return v2.release;
  }, [v2.retain, v2.release]);

  const agree = v2.comparisons.filter((c) => c.synced && Math.abs(c.deltaMs) <= AGREE_MS).length;
  const synced = v2.comparisons.filter((c) => c.synced).length;
  const busy = v2.phase !== 'ready' && v2.phase !== 'idle' && v2.phase !== 'error';

  return (
    <View style={styles.wrap}>
      <Text style={styles.h1}>v2 raw-pipeline lab</Text>
      <Text style={styles.sub}>
        {v2.phase}
        {v2.ping ? `  ·  ping ${v2.ping.rttMs.toFixed(1)}ms` : ''}
        {`  ·  engine ${v2.engineState}`}
        {v2.comparisons.length ? `  ·  agree ${agree}/${synced}` : ''}
      </Text>

      {/* Gates */}
      <Text style={styles.section}>gates</Text>
      {v2.gates.length === 0 ? (
        <Text style={styles.muted}>no heartbeats yet… (need connection)</Text>
      ) : (
        v2.gates.map((g) => (
          <View key={g.mac} style={styles.gateRow}>
            <Text style={styles.mono}>{g.mac}</Text>
            <Text style={styles.gateMeta}>
              {g.id ? `id ${g.id}` : 'unassigned'}
              {g.role ? ` · ${g.role}` : ''}
              {g.hasDisplay ? ' · OLED' : ''}
              {g.id ? ` · ${g.timeSynced ? 'synced' : 'UNSYNCED'}` : ''}
              {g.setNumber ? ` · S${g.setNumber}${g.rebootPending ? '→REBOOT' : ''}` : ''}
            </Text>
          </View>
        ))
      )}

      {/* Controls */}
      <View style={styles.row}>
        <Btn label={busy ? 'Bringing up…' : 'Re-bring-up'} onPress={v2.bringUp} disabled={!v2.connected || busy} />
        <Btn
          label={v2.swapRoles ? 'Start = other gate' : 'Start = OLED gate'}
          onPress={() => v2.setSwapRoles(!v2.swapRoles)}
          disabled={busy}
        />
      </View>
      <View style={styles.row}>
        <Btn label="Arm run (M1)" onPress={v2.armCompare} disabled={!v2.ready} kind="go" />
        <Btn label="Reset engine" onPress={v2.resetEngine} disabled={!v2.connected} />
      </View>

      {/* g1 sets (SETS-G1 §4): persist on both gates, then power-cycle both. */}
      <Text style={styles.section}>radio set (g1) — persists, applies on power-cycle</Text>
      <View style={styles.row}>
        <Btn label="Set 1 (ch1)" onPress={() => v2.changeSet(1)} disabled={!v2.ready} />
        <Btn label="Set 2 (ch6)" onPress={() => v2.changeSet(2)} disabled={!v2.ready} />
        <Btn label="Set 3 (ch11)" onPress={() => v2.changeSet(3)} disabled={!v2.ready} />
      </View>
      {v2.swapRoles ? (
        <Text style={styles.hint}>role swap pending — tap Re-bring-up to apply</Text>
      ) : null}

      {/* Comparison table */}
      <View style={styles.cmpHead}>
        <Text style={styles.cmpTitle}>v1 vs v2 split (Δ = v2 − v1)</Text>
        {v2.comparisons.length ? (
          <Pressable onPress={v2.clearComparisons}>
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
        data={v2.comparisons}
        keyExtractor={(c) => c.id}
        ListEmptyComponent={
          <Text style={styles.muted}>arm a Mode-1 rep and run both gates — rows land here paired.</Text>
        }
        renderItem={({ item }) => <CmpRow c={item} />}
      />

      <Text style={styles.section}>v2 event log</Text>
      <FlatList
        style={styles.log}
        data={v2.log}
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
  hint: { color: '#fbbf24', fontSize: 11, marginTop: 6 },
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
