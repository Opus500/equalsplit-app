// Diagnostics. The original connect-and-log screen, now riding on the shared
// GateProvider connection. Kept for hardware bring-up and protocol debugging.

import { useEffect, useState } from 'react';
import { FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { useGate } from '../ble/GateProvider';
import { describeEvent, toHex } from '../ble/decode';

type LogLine = { id: string; text: string };
let logSeq = 0;

export default function DebugScreen() {
  const gate = useGate();
  const [logs, setLogs] = useState<LogLine[]>([]);

  useEffect(() => {
    const off = gate.subscribe((raw) => {
      const stamp = new Date().toLocaleTimeString();
      setLogs((prev) =>
        [{ id: `${++logSeq}`, text: `${stamp}  <- ${describeEvent(raw)}  [${toHex(raw)}]` }, ...prev].slice(
          0,
          200,
        ),
      );
    });
    return off;
  }, [gate]);

  const connected = gate.status === 'connected';

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Diagnostics</Text>
      <Text style={styles.subtitle}>
        adapter {gate.adapterOn ? 'on' : 'off'} · {gate.status}
        {gate.gateStatus ? ` · proto ${gate.gateStatus.protoVer}` : ''}
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

      <Text style={styles.logHeader}>Event log</Text>
      <FlatList
        style={styles.log}
        data={logs}
        keyExtractor={(l) => l.id}
        renderItem={({ item }) => <Text style={styles.logLine}>{item.text}</Text>}
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
  subtitle: { color: '#8b98a9', marginTop: 4, marginBottom: 12 },
  row: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  btn: { flex: 1, backgroundColor: '#2563eb', paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
  btnWarn: { backgroundColor: '#b4541f' },
  btnText: { color: '#fff', fontWeight: '600' },
  dim: { opacity: 0.4 },
  logHeader: { color: '#8b98a9', marginTop: 8, marginBottom: 4, fontWeight: '600' },
  log: { flex: 1, backgroundColor: '#06080c', borderRadius: 8, padding: 8 },
  logLine: {
    color: '#9fe6a0',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 11,
    marginBottom: 2,
  },
});
