// EqualSplit — build-order step 1: connect-and-log.
// Goal of this screen: prove the dev build + react-native-ble-plx + permissions
// work end-to-end against the real start gate. Scan -> connect -> read Status ->
// stream raw Event notifications -> fire each command and watch the gate react.
// This is throwaway scaffolding; the real Timer/History/Settings screens land later.

import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  PermissionsAndroid,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import type { Device } from 'react-native-ble-plx';

import {
  connect,
  manager,
  monitorEvents,
  onBleStateChange,
  readLastResult,
  readStatus,
  scanForGate,
  sendCommand,
  stopScan,
} from './src/ble/bleClient';
import { Op, DEVICE_NAME_PREFIX } from './src/ble/constants';
import { describeEvent, describeStatus, toHex } from './src/ble/decode';

type LogLine = { id: string; text: string };

let logSeq = 0;

export default function App() {
  const [poweredOn, setPoweredOn] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [found, setFound] = useState<Record<string, Device>>({});
  const [device, setDevice] = useState<Device | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);

  const eventSub = useRef<{ remove: () => void } | null>(null);
  const disconnectSub = useRef<{ remove: () => void } | null>(null);

  const log = useCallback((text: string) => {
    const stamp = new Date().toLocaleTimeString();
    setLogs((prev) => [{ id: `${++logSeq}`, text: `${stamp}  ${text}` }, ...prev].slice(0, 200));
  }, []);

  // Track adapter power state (also triggers the iOS Bluetooth prompt).
  useEffect(() => {
    const sub = onBleStateChange((s) => {
      setPoweredOn(s === 'PoweredOn');
      log(`BLE adapter: ${s}`);
    });
    return () => sub.remove();
  }, [log]);

  const cleanupConnection = useCallback(() => {
    eventSub.current?.remove();
    disconnectSub.current?.remove();
    eventSub.current = null;
    disconnectSub.current = null;
  }, []);

  useEffect(() => () => cleanupConnection(), [cleanupConnection]);

  async function ensureAndroidPermissions(): Promise<boolean> {
    if (Platform.OS !== 'android') return true;
    const sdk = typeof Platform.Version === 'number' ? Platform.Version : 0;
    const perms =
      sdk >= 31
        ? [
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          ]
        : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
    const res = await PermissionsAndroid.requestMultiple(perms);
    const ok = Object.values(res).every((v) => v === PermissionsAndroid.RESULTS.GRANTED);
    if (!ok) log('Android BLE permissions denied');
    return ok;
  }

  async function handleScan() {
    if (!(await ensureAndroidPermissions())) return;
    setFound({});
    setScanning(true);
    log(`Scanning for ${DEVICE_NAME_PREFIX} gate...`);
    scanForGate(
      (d) => {
        setFound((prev) => (prev[d.id] ? prev : { ...prev, [d.id]: d }));
      },
      (e) => {
        log(`Scan error: ${e.message}`);
        setScanning(false);
      },
    );
    // Gate advertises continuously; stop after 12 s to save battery.
    setTimeout(() => {
      stopScan();
      setScanning(false);
    }, 12000);
  }

  async function handleConnect(target: Device) {
    stopScan();
    setScanning(false);
    log(`Connecting to ${target.name ?? target.id}...`);
    try {
      const d = await connect(target);
      setDevice(d);
      log(`Connected: ${d.name ?? d.id}`);

      disconnectSub.current = manager.onDeviceDisconnected(d.id, (err) => {
        log(`Disconnected${err ? `: ${err.message}` : ''}`);
        cleanupConnection();
        setDevice(null);
      });

      const status = await readStatus(d);
      if (status) log(describeStatus(status));
      const last = await readLastResult(d);
      if (last && last.length) log(`LastResult bytes: ${toHex(last)}`);

      eventSub.current = monitorEvents(
        d,
        (bytes) => log(`<- ${describeEvent(bytes)}   [${toHex(bytes)}]`),
        (e) => log(`Event stream error: ${e.message}`),
      );
      log('Subscribed to Event notifications.');
    } catch (e) {
      log(`Connect failed: ${(e as Error).message}`);
    }
  }

  async function handleDisconnect() {
    if (!device) return;
    try {
      await device.cancelConnection();
    } catch {
      /* already gone */
    }
  }

  async function cmd(op: Op, label: string, arg0 = 0, arg1 = 0) {
    if (!device) return;
    try {
      await sendCommand(device, op, arg0, arg1);
      log(`-> ${label}`);
    } catch (e) {
      log(`Command ${label} failed: ${(e as Error).message}`);
    }
  }

  const foundList = Object.values(found);
  const connected = !!device;

  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      <Text style={styles.title}>EqualSplit — BLE link test</Text>
      <Text style={styles.subtitle}>
        adapter: {poweredOn ? 'on' : 'off'} · {connected ? 'connected' : 'disconnected'}
      </Text>

      {!connected ? (
        <>
          <Row>
            <Btn label={scanning ? 'Scanning…' : 'Scan'} onPress={handleScan} disabled={!poweredOn || scanning} />
          </Row>
          {foundList.map((d) => (
            <Btn key={d.id} label={`Connect → ${d.name ?? d.id}`} onPress={() => handleConnect(d)} />
          ))}
        </>
      ) : (
        <>
          <Row>
            <Btn label="Arm M1" onPress={() => cmd(Op.ArmMode1, 'ARM_MODE1')} />
            <Btn label="Arm M2" onPress={() => cmd(Op.ArmMode2, 'ARM_MODE2')} />
          </Row>
          <Row>
            <Btn label="Start seq" onPress={() => cmd(Op.StartSequence, 'START_SEQUENCE')} />
            <Btn label="Reset" onPress={() => cmd(Op.Reset, 'RESET')} />
          </Row>
          <Row>
            <Btn label="Disconnect" onPress={handleDisconnect} kind="warn" />
          </Row>
        </>
      )}

      <Text style={styles.logHeader}>Log</Text>
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
        (disabled || pressed) && styles.btnDim,
      ]}
    >
      <Text style={styles.btnText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0e1116', paddingTop: 64, paddingHorizontal: 16 },
  title: { color: '#fff', fontSize: 20, fontWeight: '700' },
  subtitle: { color: '#8b98a9', marginTop: 4, marginBottom: 12 },
  row: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  btn: { flex: 1, backgroundColor: '#2563eb', paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
  btnWarn: { backgroundColor: '#b4541f' },
  btnDim: { opacity: 0.5 },
  btnText: { color: '#fff', fontWeight: '600' },
  logHeader: { color: '#8b98a9', marginTop: 8, marginBottom: 4, fontWeight: '600' },
  log: { flex: 1, backgroundColor: '#06080c', borderRadius: 8, padding: 8 },
  logLine: { color: '#9fe6a0', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 11, marginBottom: 2 },
});
