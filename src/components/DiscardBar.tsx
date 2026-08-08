// The post-run discard control. Shared by all three timing screens.
//
// It NAMES the run it will delete. With the window moving to the newest run, an
// unlabelled "Discard" is one glance away from binning the wrong rep — a false
// trigger followed by the real run is exactly the sequence where that bites.
//
// "Keep" is not decoration: it is how the coach clears the bar from the screen
// deliberately, and it settles the run permanently.

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { usePendingRun } from '../runs/PendingRunProvider';
import { describe } from '../runs/pending';

export function DiscardBar() {
  const { state, discard, dismiss } = usePendingRun();

  if (state.lastReason === 'discarded') {
    return (
      <View style={[styles.bar, styles.barDone]}>
        <Text style={styles.doneText}>Run discarded</Text>
      </View>
    );
  }

  const p = state.pending;
  if (!p) return null;

  return (
    <View style={styles.bar}>
      <View style={styles.textCol}>
        <Text style={styles.kicker}>JUST RECORDED</Text>
        <Text style={styles.subject} numberOfLines={1}>
          {describe(p)}
        </Text>
      </View>

      <Pressable
        onPress={dismiss}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`Keep ${describe(p)}`}
        style={({ pressed }) => [styles.btn, pressed && styles.dim]}
      >
        <Text style={styles.keepText}>Keep</Text>
      </Pressable>

      <Pressable
        onPress={discard}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`Discard ${describe(p)}`}
        style={({ pressed }) => [styles.btn, styles.btnDiscard, pressed && styles.dim]}
      >
        <Text style={styles.discardText}>Discard</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#161b22',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
    marginTop: 6,
    borderWidth: 1,
    borderColor: '#243042',
  },
  barDone: { justifyContent: 'center', borderColor: '#3f2a2a', backgroundColor: '#1a1214' },
  doneText: { color: '#f87171', fontSize: 13, fontWeight: '700', paddingVertical: 4 },
  textCol: { flex: 1, minWidth: 0 },
  kicker: { color: '#64748b', fontSize: 9, fontWeight: '800', letterSpacing: 0.8 },
  subject: { color: '#e2e8f0', fontSize: 14, fontWeight: '700', marginTop: 2 },
  btn: {
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: '#243042',
    backgroundColor: '#0b0e13',
    minWidth: 62,
    alignItems: 'center',
  },
  btnDiscard: { borderColor: '#7f1d1d', backgroundColor: '#1a1214' },
  keepText: { color: '#94a3b8', fontSize: 13, fontWeight: '800' },
  discardText: { color: '#f87171', fontSize: 13, fontWeight: '800' },
  dim: { opacity: 0.6 },
});
