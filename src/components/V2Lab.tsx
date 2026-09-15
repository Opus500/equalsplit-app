// Dev-only v2 session surface: bring-up, role swap, the radio-set controls and
// the bare-gate recovery path (SETS-G1 §4), plus the raw v2 event log.
//
// This was the acceptance-test bench (docs/BLE-CONTRACT.md §14): it armed v1 and
// v2 together and tabled each rep's v1-vs-v2 split. That test passed in July and
// the frozen firmware deleted v1, so "Arm run (M1)" could never fill its v1 column
// again — it and the table are gone. What remains is the tool for a stranded gate.

import { useEffect } from 'react';
import { FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { useV2 } from '../ble/V2Provider';
import { CAUTION, INTERACTIVE_SOFT, LIVE_FILL } from '../theme';

export default function V2Lab() {
  const v2 = useV2();

  // Activate the v2 session while this view is mounted; go dormant on leave.
  useEffect(() => {
    v2.retain();
    return v2.release;
  }, [v2.retain, v2.release]);

  const busy = v2.phase !== 'ready' && v2.phase !== 'idle' && v2.phase !== 'error';

  return (
    <View style={styles.wrap}>
      <Text style={styles.h1}>v2 raw-pipeline lab</Text>
      <Text style={styles.sub}>
        {v2.phase}
        {v2.ping ? `  ·  ping ${v2.ping.rttMs.toFixed(1)}ms` : ''}
        {`  ·  engine ${v2.engineState}`}
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
        <Btn label="Reset engine" onPress={v2.resetEngine} disabled={!v2.connected} />
      </View>

      {/* g1 sets (SETS-G1 §4): persist, then power-cycle. Deliberately usable
          WITHOUT a ready session — connected-only — so a solitary gate stranded
          on the wrong set can be rescued over BLE (the bare-gate recovery path). */}
      <Text style={styles.section}>radio set (g1) — persists, applies on power-cycle</Text>
      <View style={styles.row}>
        <Btn label="Set 1 (ch1)" onPress={() => v2.changeSet(1)} disabled={!v2.connected} />
        <Btn label="Set 2 (ch6)" onPress={() => v2.changeSet(2)} disabled={!v2.connected} />
        <Btn label="Set 3 (ch11)" onPress={() => v2.changeSet(3)} disabled={!v2.connected} />
      </View>
      <View style={styles.row}>
        <Btn label="Restore defaults (recovery)" onPress={v2.restoreDefaults} disabled={!v2.connected} />
      </View>
      {v2.connected && !v2.ready ? (
        <Text style={styles.hint}>recovery mode — commands go to whichever gates reply</Text>
      ) : null}
      {v2.swapRoles ? (
        <Text style={styles.hint}>role swap pending — tap Re-bring-up to apply</Text>
      ) : null}

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
  hint: { color: CAUTION, fontSize: 11, marginTop: 6 },
  gateRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  mono: { color: '#cbd5e1', fontFamily: mono, fontSize: 12 },
  gateMeta: { color: INTERACTIVE_SOFT, fontSize: 12 },
  row: { flexDirection: 'row', gap: 8, marginTop: 8 },
  btn: { flex: 1, backgroundColor: '#2563eb', paddingVertical: 11, borderRadius: 10, alignItems: 'center' },
  btnGo: { backgroundColor: LIVE_FILL },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  dim: { opacity: 0.4 },
  log: { flex: 1, backgroundColor: '#06080c', borderRadius: 8, padding: 8, marginTop: 4 },
  logLine: { color: '#9fe6a0', fontFamily: mono, fontSize: 11, marginBottom: 2 },
});
