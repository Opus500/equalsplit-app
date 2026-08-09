// The Drills tab: ONE screen, one drill dropdown.
//
// Replaced a segmented switch, which does not scale — every drill added would
// have taken another slot in a fixed row. A list does, and the list is DERIVED
// from the engine configs (src/ble/catalog.ts), so adding a drill needs no edit
// here at all.
//
// Both engine screens stay mounted, only hidden — same reason Timer and Drills
// are mounted at the app root: unmounting drops an in-progress set and the
// per-run save guards. Switching drills must never cost a live rep.
//
// Each screen is CONTROLLED here via `selectedKey`, which also hides its own
// picker (two pickers both saying "L Drill" was the thing being removed) and
// tightens its top padding, since this header already clears the status bar.
// With the prop absent both screens behave exactly as before — the property
// scripts/verify-catalog.mjs block 1 exists to prove.

import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { DRILL_CATALOG, entryFor, kindFor } from '../ble/catalog';
import { SetControl } from '../components/SetControl';
import DrillsScreen from './DrillsScreen';
import RepeatsScreen from './RepeatsScreen';

export default function DrillsTab() {
  const [key, setKey] = useState<string>(DRILL_CATALOG[0]!.key);
  const [picking, setPicking] = useState(false);
  const active = useMemo(() => entryFor(key) ?? DRILL_CATALOG[0]!, [key]);
  const kind = kindFor(active.key);

  // Which set the phone controls is the thing you check mid-session without
  // wanting to scroll for it, so it is PINNED. The drill you pick once at the
  // start, so it rides the content and scrolls away.
  const dropdown = (
    <Pressable
      onPress={() => setPicking(true)}
      style={({ pressed }) => [styles.header, pressed && styles.dim]}
    >
      <View style={styles.headerText}>
        <Text style={styles.kicker}>DRILL</Text>
        <Text style={styles.title} numberOfLines={1}>
          {active.title}
        </Text>
      </View>
      <Text style={styles.chev}>▾</Text>
    </Pressable>
  );

  return (
    <View style={styles.root}>
      <View style={styles.pinned}>
        <SetControl />
      </View>

      <View style={styles.body}>
        <View style={[styles.fill, kind !== 'counted' && styles.hidden]}>
          <DrillsScreen
            selectedKey={kind === 'counted' ? active.key : undefined}
            header={kind === 'counted' ? dropdown : undefined}
          />
        </View>
        <View style={[styles.fill, kind !== 'repeat' && styles.hidden]}>
          <RepeatsScreen
            selectedKey={kind === 'repeat' ? active.key : undefined}
            header={kind === 'repeat' ? dropdown : undefined}
          />
        </View>
      </View>

      <Modal visible={picking} transparent animationType="fade" onRequestClose={() => setPicking(false)}>
        <Pressable style={styles.backdrop} onPress={() => setPicking(false)}>
          <Pressable style={styles.card} onPress={() => {}}>
            <Text style={styles.cardTitle}>Drill</Text>
            <ScrollView style={styles.list}>
              {DRILL_CATALOG.map((e) => (
                <Pressable
                  key={e.key}
                  onPress={() => {
                    setKey(e.key);
                    setPicking(false);
                  }}
                  style={({ pressed }) => [
                    styles.row,
                    e.key === active.key && styles.rowOn,
                    pressed && styles.dim,
                  ]}
                >
                  <View style={styles.rowText}>
                    <Text style={styles.rowTitle}>{e.title}</Text>
                    <Text style={styles.rowBlurb}>{e.blurb}</Text>
                  </View>
                  {e.key === active.key ? <Text style={styles.check}>✓</Text> : null}
                </Pressable>
              ))}
            </ScrollView>
            <Pressable
              onPress={() => setPicking(false)}
              style={({ pressed }) => [styles.close, pressed && styles.dim]}
            >
              <Text style={styles.closeText}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0e1116' },
  // Pinned: outside the scroll, so the set badge never leaves the screen.
  pinned: { paddingTop: 52, paddingHorizontal: 16, paddingBottom: 2 },
  // Rides the scrolling content, hence no top margin — the hosted screen's
  // contentEmbedded padding is the only gap above it.
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 4,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#243042',
    backgroundColor: '#161b22',
  },
  headerText: { flex: 1, minWidth: 0 },
  kicker: { color: '#64748b', fontSize: 9, fontWeight: '800', letterSpacing: 0.8 },
  title: { color: '#fff', fontSize: 17, fontWeight: '800', marginTop: 1 },
  chev: { color: '#60a5fa', fontSize: 15, fontWeight: '800' },
  body: { flex: 1 },
  fill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  hidden: { display: 'none' },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  card: { backgroundColor: '#161b22', borderRadius: 16, padding: 18, maxHeight: '80%' },
  cardTitle: { color: '#fff', fontSize: 17, fontWeight: '800', marginBottom: 12 },
  list: { flexGrow: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#0b0e13',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#243042',
  },
  rowOn: { borderColor: '#3b82f6', backgroundColor: '#12203a' },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: { color: '#e2e8f0', fontSize: 15, fontWeight: '700' },
  rowBlurb: { color: '#64748b', fontSize: 11, marginTop: 2 },
  check: { color: '#34d399', fontSize: 18, fontWeight: '800' },
  close: {
    marginTop: 4,
    backgroundColor: '#243042',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  closeText: { color: '#cbd5e1', fontWeight: '700' },
  dim: { opacity: 0.6 },
});
