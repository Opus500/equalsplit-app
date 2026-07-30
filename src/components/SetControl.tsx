// Set awareness + deterministic set selection (SETS-G1). With several sets
// powered in one space, every gate advertises the same service, so a one-tap
// connect can land on the wrong set's bridge. This gives (1) a prominent badge of
// the set the phone is CURRENTLY controlling, and (2) a pre-connect picker that
// reads the g1-a3 scan-response set byte (FF FF 0N) so you can choose Set 1/2/3
// BEFORE connecting.
//
// Deliberately ADDITIVE: the picker only ever calls the existing gate.connectTo /
// gate.disconnect — it does NOT touch quickConnect, auto-reconnect, or bring-up.
// After a pick, the app's normal last-gate stickiness + drop-reconnect keep the
// phone on that set. If a gate's set can't be read (mfg-data not surfaced), it
// still appears under "set unknown" and stays connectable, so the picker can
// never be worse than the plain one-tap connect.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Device } from 'react-native-ble-plx';

import { useGate } from '../ble/GateProvider';
import { useV2 } from '../ble/V2Provider';
import { scanForGatesWithData, stopScan } from '../ble/bleClient';
import { parseAdvSet } from '../ble/v2';

type Found = { device: Device; name: string; set: number | null; rssi: number };

const SET_COLORS: Record<number, string> = { 1: '#2563eb', 2: '#16a34a', 3: '#a855f7' };
const setColor = (s: number | null | undefined) => (s ? SET_COLORS[s] ?? '#475569' : '#475569');

export function SetControl() {
  const gate = useGate();
  const v2 = useV2();
  const [open, setOpen] = useState(false);
  const connected = gate.status === 'connected';
  const currentSet = v2.gates.find((g) => g.setNumber > 0)?.setNumber ?? null;

  const onPick = useCallback(
    async (d: Device) => {
      setOpen(false);
      // Switch cleanly: drop the current link (no auto-reconnect) then connect the
      // chosen gate. connectTo stops any scan and runs a fresh bring-up for the set.
      try {
        if (gate.status === 'connected' || gate.status === 'reconnecting') await gate.disconnect();
      } catch {
        /* already gone */
      }
      gate.connectTo(d);
    },
    [gate],
  );

  return (
    <View style={styles.wrap}>
      {connected && currentSet ? (
        <View style={[styles.badge, { backgroundColor: setColor(currentSet) }]}>
          <Text style={styles.badgeText}>SET {currentSet}</Text>
        </View>
      ) : (
        <View style={[styles.badge, styles.badgeMuted]}>
          <Text style={styles.badgeMutedText}>{connected ? 'set ?' : 'no set'}</Text>
        </View>
      )}
      <Pressable onPress={() => setOpen(true)} hitSlop={8}>
        <Text style={styles.link}>Choose set</Text>
      </Pressable>
      <SetPickerModal
        visible={open}
        currentSet={currentSet}
        onClose={() => setOpen(false)}
        onPick={onPick}
      />
    </View>
  );
}

function SetPickerModal({
  visible,
  currentSet,
  onClose,
  onPick,
}: {
  visible: boolean;
  currentSet: number | null;
  onClose: () => void;
  onPick: (d: Device) => void;
}) {
  const [found, setFound] = useState<Record<string, Found>>({});
  const [scanning, setScanning] = useState(false);
  const foundRef = useRef<Record<string, Found>>({});
  const sigRef = useRef('');
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startScan = useCallback(() => {
    stopScan();
    foundRef.current = {};
    sigRef.current = '';
    setFound({});
    setScanning(true);
    scanForGatesWithData(
      (d) => {
        const set = parseAdvSet(d.manufacturerData);
        const prev = foundRef.current[d.id];
        const next: Found = {
          device: d,
          name: d.localName || d.name || d.id,
          // Never overwrite a known set with a later null (the set byte rides the
          // scan response and can be missing on some reports); keep the best rssi.
          set: set ?? prev?.set ?? null,
          rssi: typeof d.rssi === 'number' ? d.rssi : (prev?.rssi ?? -127),
        };
        foundRef.current = { ...foundRef.current, [d.id]: next };
        // Re-render only when the gate list or any resolved set changes — an
        // allow-duplicates scan fires constantly, and rssi jitter shouldn't churn.
        const sig = Object.keys(foundRef.current)
          .sort()
          .map((id) => `${id}:${foundRef.current[id].set ?? '?'}`)
          .join('|');
        if (sig !== sigRef.current) {
          sigRef.current = sig;
          setFound(foundRef.current);
        }
      },
      () => {
        stopScan();
        setScanning(false);
      },
    );
    if (stopTimer.current) clearTimeout(stopTimer.current);
    stopTimer.current = setTimeout(() => {
      stopScan();
      setScanning(false);
    }, 8000);
  }, []);

  useEffect(() => {
    if (visible) startScan();
    return () => {
      stopScan();
      setScanning(false);
      if (stopTimer.current) clearTimeout(stopTimer.current);
    };
  }, [visible, startScan]);

  const items = Object.values(found);
  const bySet: Record<string, Found[]> = {};
  for (const it of items) {
    const key = it.set == null ? 'unknown' : String(it.set);
    (bySet[key] ??= []).push(it);
  }
  const strongestOf = (list: Found[]) => [...list].sort((a, b) => b.rssi - a.rssi)[0];
  const unknown = (bySet.unknown ?? []).sort((a, b) => b.rssi - a.rssi);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.card} onPress={() => {}}>
          <Text style={styles.cardTitle}>Choose this phone&apos;s set</Text>
          <Text style={styles.cardSub}>
            Each station has its own set. Pick the set you want to control — the app connects to that
            set&apos;s gate and stays on it.
          </Text>

          <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
            {[1, 2, 3].map((n) => {
              const list = bySet[String(n)] ?? [];
              const has = list.length > 0;
              return (
                <Pressable
                  key={n}
                  disabled={!has}
                  onPress={() => has && onPick(strongestOf(list).device)}
                  style={({ pressed }) => [
                    styles.setRow,
                    !has && styles.setRowDim,
                    pressed && has && styles.setRowPressed,
                  ]}
                >
                  <View style={[styles.dot, { backgroundColor: setColor(n) }]} />
                  <Text style={styles.setLabel}>Set {n}</Text>
                  <View style={{ flex: 1 }} />
                  {currentSet === n ? <Text style={styles.current}>current</Text> : null}
                  <Text style={styles.setMeta}>
                    {has ? `${list.length} gate${list.length > 1 ? 's' : ''} · connect` : 'not seen'}
                  </Text>
                </Pressable>
              );
            })}

            {unknown.length ? (
              <>
                <Text style={styles.unknownHead}>Gates with no readable set</Text>
                {unknown.map((it) => (
                  <Pressable
                    key={it.device.id}
                    onPress={() => onPick(it.device)}
                    style={({ pressed }) => [styles.setRow, pressed && styles.setRowPressed]}
                  >
                    <View style={[styles.dot, styles.badgeMuted]} />
                    <Text style={styles.setLabel} numberOfLines={1}>
                      {it.name}
                    </Text>
                    <View style={{ flex: 1 }} />
                    <Text style={styles.setMeta}>connect</Text>
                  </Pressable>
                ))}
              </>
            ) : null}

            {items.length === 0 ? (
              <Text style={styles.empty}>
                {scanning ? 'Scanning for gates…' : 'No gates found. Power them and rescan.'}
              </Text>
            ) : null}
          </ScrollView>

          <View style={styles.footer}>
            <View style={styles.scanState}>
              {scanning ? <ActivityIndicator size="small" color="#60a5fa" /> : null}
              <Text style={styles.scanText}>{scanning ? 'Scanning…' : 'Scan complete'}</Text>
            </View>
            <Pressable onPress={startScan} hitSlop={8}>
              <Text style={styles.link}>Rescan</Text>
            </Pressable>
          </View>

          <Pressable onPress={onClose} style={({ pressed }) => [styles.closeBtn, pressed && styles.dim]}>
            <Text style={styles.closeText}>Close</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  badge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  badgeText: { color: '#fff', fontSize: 12, fontWeight: '800', letterSpacing: 0.5 },
  badgeMuted: { backgroundColor: '#243042' },
  badgeMutedText: { color: '#94a3b8', fontSize: 12, fontWeight: '700' },
  link: { color: '#60a5fa', fontWeight: '700', fontSize: 13 },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  card: { backgroundColor: '#161b22', borderRadius: 16, padding: 18, maxHeight: '80%' },
  cardTitle: { color: '#fff', fontSize: 17, fontWeight: '800' },
  cardSub: { color: '#94a3b8', fontSize: 13, lineHeight: 18, marginTop: 6, marginBottom: 8 },
  list: { flexGrow: 0 },
  setRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#0b0e13',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 14,
    marginTop: 8,
    borderWidth: 1,
    borderColor: '#243042',
  },
  setRowDim: { opacity: 0.4 },
  setRowPressed: { borderColor: '#3b82f6' },
  dot: { width: 12, height: 12, borderRadius: 6 },
  setLabel: { color: '#e2e8f0', fontSize: 16, fontWeight: '700' },
  setMeta: { color: '#64748b', fontSize: 12 },
  current: { color: '#34d399', fontSize: 11, fontWeight: '800', marginRight: 8 },
  unknownHead: { color: '#64748b', fontSize: 12, fontWeight: '700', marginTop: 14 },
  empty: { color: '#64748b', fontSize: 13, textAlign: 'center', paddingVertical: 20 },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 14,
  },
  scanState: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  scanText: { color: '#94a3b8', fontSize: 12 },
  closeBtn: {
    marginTop: 12,
    backgroundColor: '#243042',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  closeText: { color: '#cbd5e1', fontWeight: '700' },
  dim: { opacity: 0.5 },
});
