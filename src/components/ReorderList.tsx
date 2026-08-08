// Tap-to-place reordering. Pure JS — no gesture-handler, no reanimated.
//
// Tap a row to pick it up; the gaps between rows become drop slots; tap a slot to
// place it. Tap the picked row again to cancel.
//
// Chosen over drag-and-drop deliberately: a long-press-drag on a phone held in one
// hand at the side of a track is a fiddly gesture, and it would have cost two
// native dependencies. Two taps are also interruptible — you can look up at the
// athletes mid-reorder and come back to it.
//
// The slot -> index conversion is slotToIndex() in ../roster/queue, verified
// exhaustively (all 20 from/slot pairs on a 4-lineup) by scripts/verify-queue.mjs.

import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { slotToIndex } from '../roster/queue';

export type ReorderItem = {
  id: string;
  label: string;
  sub?: string | null;
  /** marks the athlete currently up, when this is the live lineup */
  current?: boolean;
};

export function ReorderList({
  items,
  onMove,
  onRemove,
  emptyText = 'Nobody in the lineup yet.',
}: {
  items: ReorderItem[];
  onMove: (from: number, to: number) => void;
  onRemove?: (id: string) => void;
  emptyText?: string;
}) {
  const [picked, setPicked] = useState<number | null>(null);

  // A pick is an index, so any change to the list length invalidates it.
  if (picked != null && picked >= items.length) setPicked(null);

  const place = (slot: number) => {
    if (picked == null) return;
    onMove(picked, slotToIndex(picked, slot));
    setPicked(null);
  };

  if (!items.length) return <Text style={styles.empty}>{emptyText}</Text>;

  return (
    <View>
      {picked != null ? (
        <Text style={styles.banner}>
          Moving <Text style={styles.bannerName}>{items[picked]!.label}</Text> — tap a line to
          place, or tap them again to cancel
        </Text>
      ) : (
        <Text style={styles.hint}>Tap an athlete to move them</Text>
      )}

      {items.map((it, i) => (
        <View key={it.id}>
          <Slot active={picked != null} index={i} pickedIndex={picked} onPress={() => place(i)} />
          <Pressable
            onPress={() => setPicked(picked === i ? null : i)}
            style={({ pressed }) => [
              styles.row,
              it.current && styles.rowCurrent,
              picked === i && styles.rowPicked,
              pressed && styles.dim,
            ]}
          >
            <Text style={styles.pos}>{i + 1}</Text>
            <View style={styles.textCol}>
              <Text style={[styles.name, picked === i && styles.namePicked]} numberOfLines={1}>
                {it.label}
              </Text>
              {it.sub ? (
                <Text style={styles.sub} numberOfLines={1}>
                  {it.sub}
                </Text>
              ) : null}
            </View>
            {it.current ? <Text style={styles.upNow}>UP</Text> : null}
            {picked === i ? (
              <Text style={styles.grabbed}>moving</Text>
            ) : onRemove ? (
              <Pressable
                onPress={() => onRemove(it.id)}
                hitSlop={8}
                style={({ pressed }) => [styles.removeBtn, pressed && styles.dim]}
              >
                <Text style={styles.removeText}>Remove</Text>
              </Pressable>
            ) : null}
          </Pressable>
        </View>
      ))}

      {/* The final slot, below the last row. */}
      <Slot
        active={picked != null}
        index={items.length}
        pickedIndex={picked}
        onPress={() => place(items.length)}
        last
      />
    </View>
  );
}

/**
 * A drop target between two rows. Rendered at full height only while something is
 * picked up, so the list doesn't sit permanently spaced out by invisible gaps.
 *
 * The two slots adjacent to the picked row are "leave it where it is" — shown
 * muted rather than hidden, so the list doesn't reflow as you look at it.
 */
function Slot({
  active,
  index,
  pickedIndex,
  onPress,
  last,
}: {
  active: boolean;
  index: number;
  pickedIndex: number | null;
  onPress: () => void;
  last?: boolean;
}) {
  if (!active) return <View style={last ? undefined : styles.gap} />;
  const inert = pickedIndex != null && (index === pickedIndex || index === pickedIndex + 1);
  return (
    <Pressable
      onPress={onPress}
      disabled={inert}
      hitSlop={{ top: 4, bottom: 4 }}
      style={({ pressed }) => [styles.slot, pressed && !inert && styles.slotPressed]}
    >
      <View style={[styles.slotLine, inert && styles.slotLineInert]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  empty: { color: '#64748b', fontSize: 13, textAlign: 'center', paddingVertical: 22, lineHeight: 19 },
  hint: { color: '#475569', fontSize: 11, marginBottom: 8 },
  banner: {
    color: '#93c5fd',
    fontSize: 12,
    lineHeight: 17,
    backgroundColor: '#16233a',
    borderRadius: 8,
    paddingVertical: 7,
    paddingHorizontal: 10,
    marginBottom: 8,
  },
  bannerName: { fontWeight: '800', color: '#dbeafe' },
  gap: { height: 8 },
  // Tall enough to be a real target between two rows without pushing the list
  // off screen while reordering.
  slot: { height: 30, justifyContent: 'center', paddingHorizontal: 4 },
  slotPressed: { opacity: 0.6 },
  slotLine: { height: 3, borderRadius: 2, backgroundColor: '#3b82f6' },
  slotLineInert: { backgroundColor: '#1c2432' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#161b22',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: '#243042',
  },
  rowCurrent: { borderColor: '#3b82f6' },
  rowPicked: { borderColor: '#60a5fa', backgroundColor: '#16233a' },
  pos: {
    color: '#475569',
    fontSize: 12,
    fontWeight: '800',
    width: 18,
    fontVariant: ['tabular-nums'],
  },
  textCol: { flex: 1, minWidth: 0 },
  name: { color: '#e2e8f0', fontSize: 15, fontWeight: '700' },
  namePicked: { color: '#fff' },
  sub: { color: '#64748b', fontSize: 11, marginTop: 2 },
  upNow: { color: '#60a5fa', fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
  grabbed: { color: '#60a5fa', fontSize: 11, fontWeight: '700', fontStyle: 'italic' },
  removeBtn: {
    paddingHorizontal: 9,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#243042',
  },
  removeText: { color: '#94a3b8', fontSize: 11, fontWeight: '700' },
  dim: { opacity: 0.6 },
});
