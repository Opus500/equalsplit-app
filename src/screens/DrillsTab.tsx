// The Drills tab holds two engines: the counted drills (L Drill, Shuttle Run) and
// rep sets (single-gate intervals). A segmented switch rather than a sixth tab.
//
// BOTH stay mounted, only hidden — same reason Timer and Drills are mounted at the
// app root: unmounting would drop an in-progress set and the per-run save guards.
// Switching here must never cost a live set.

import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import DrillsScreen from './DrillsScreen';
import RepeatsScreen from './RepeatsScreen';

type View_ = 'drills' | 'repeats';

export default function DrillsTab() {
  const [view, setView] = useState<View_>('drills');

  return (
    <View style={styles.root}>
      <View style={styles.seg}>
        <Seg label="Drills" active={view === 'drills'} onPress={() => setView('drills')} />
        <Seg label="Rep sets" active={view === 'repeats'} onPress={() => setView('repeats')} />
      </View>

      <View style={styles.body}>
        <View style={[styles.fill, view !== 'drills' && styles.hidden]}>
          <DrillsScreen />
        </View>
        <View style={[styles.fill, view !== 'repeats' && styles.hidden]}>
          <RepeatsScreen />
        </View>
      </View>
    </View>
  );
}

function Seg({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.segBtn, active && styles.segOn, pressed && styles.dim]}
    >
      <Text style={[styles.segText, active && styles.segTextOn]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0e1116' },
  // Sits above both screens, which supply their own top padding.
  seg: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 52,
    paddingBottom: 4,
    zIndex: 2,
  },
  segBtn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#243042',
    backgroundColor: '#0b0e13',
  },
  segOn: { backgroundColor: '#1e3a5f', borderColor: '#3b82f6' },
  segText: { color: '#64748b', fontSize: 12, fontWeight: '800' },
  segTextOn: { color: '#dbeafe' },
  body: { flex: 1 },
  fill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  hidden: { display: 'none' },
  dim: { opacity: 0.6 },
});
