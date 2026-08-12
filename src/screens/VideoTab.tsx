// The Video tab: mark a clip, or manage the clips already stored.
//
// Same shape as DrillsTab — a thin wrapper holding two sibling screens behind a
// switch, so neither knows about the other.
//
// Mark is UNMOUNTED when Library is showing, unlike DrillsTab where the engine
// screens stay mounted. There is no in-progress state worth preserving here (an
// unsaved mark is cheap to redo), and it holds a video player plus a decoded
// filmstrip which should not sit in memory behind a list. Library remounts on
// every visit for the opposite reason: it reads the filesystem, and a stale list
// after a delete elsewhere would be worse than a reload.

import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import VideoMarkScreen from './VideoMarkScreen';
import VideoLibraryScreen from './VideoLibraryScreen';

type Pane = 'mark' | 'library';

export default function VideoTab() {
  const [pane, setPane] = useState<Pane>('mark');

  return (
    <View style={styles.root}>
      <View style={styles.fill}>
        {pane === 'mark' ? <VideoMarkScreen /> : <VideoLibraryScreen />}
      </View>

      <View style={styles.switch}>
        <Seg label="Mark" active={pane === 'mark'} onPress={() => setPane('mark')} />
        <Seg label="Videos" active={pane === 'library'} onPress={() => setPane('library')} />
      </View>
    </View>
  );
}

function Seg({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      style={[styles.seg, active && styles.segOn]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
    >
      <Text style={[styles.segText, active && styles.segTextOn]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0e1116' },
  fill: { flex: 1 },
  switch: {
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 10,
    paddingTop: 6,
    paddingBottom: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#1f2733',
  },
  seg: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 8, backgroundColor: '#131a24' },
  segOn: { backgroundColor: '#1d4ed8' },
  segText: { color: '#94a3b8', fontSize: 13, fontWeight: '600' },
  segTextOn: { color: '#fff' },
});
