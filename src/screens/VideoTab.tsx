// The Video tab: mark a clip, or manage the clips already stored.
//
// Same shape as DrillsTab — a thin wrapper holding two sibling screens behind a
// switch, so neither knows about the other.
//
// Mark stays MOUNTED and is hidden, like Timer and Drills. It was unmounted, on
// the reasoning that an unsaved mark is cheap to redo — which was wrong: an
// imported clip is a file copy plus a filmstrip build plus however long the coach
// spent placing two handles, and losing all of that to a glance at the library is
// not a cheap redo. It is told when it is hidden so it can pause the player and
// stop holding a decoder for a screen nobody is looking at.
//
// Library still remounts on every visit, for the opposite reason: it reads the
// filesystem, and a stale list after a delete would be worse than a reload.

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
        <View style={[styles.fill, pane !== 'mark' && styles.hidden]}>
          <VideoMarkScreen isVisible={pane === 'mark'} />
        </View>
        {pane === 'library' ? <VideoLibraryScreen /> : null}
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
  hidden: { display: 'none' },
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
