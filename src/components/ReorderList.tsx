// Tap-to-place reordering. Pure JS — no gesture-handler, no reanimated, and no
// native rebuild.
//
// The failure mode of naive tap-to-place is that it reads as two disconnected
// taps: you tap a name, something invisible happens, you tap again and hope. Five
// things fix that here, all with core RN:
//
//  1. LayoutAnimation on every move — the row visibly TRAVELS to its new position
//     instead of the list teleporting. This is the single biggest difference; it
//     is what connects the two taps into one action.
//  2. Slots become explicit, labelled drop zones ("→ 3") only while a move is
//     live, so a tap lands where you can see it will land.
//  3. Everything except the picked row dims, so the subject of the move is
//     unmistakable without any motion.
//  4. Nudge arrows on the picked row. Moving someone ONE place — the common case —
//     becomes a single repeatable tap, never a two-tap round trip.
//  5. The moved row stays highlighted briefly after landing, so you can confirm
//     where it went without re-reading the whole list.
//
// Deliberately NOT used: haptics. expo-haptics is not a dependency and would need
// a native rebuild; core `Vibration` on iOS is a full buzz, not a light tick, and
// would feel worse than silence for a UI nudge.

import { useEffect, useRef, useState } from 'react';
import {
  LayoutAnimation,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  UIManager,
  View,
} from 'react-native';

import { slotToIndex } from '../roster/queue';
import {
  INTERACTIVE,
  INTERACTIVE_ON_BG,
  INTERACTIVE_SOFT,
  INTERACTIVE_STRONG,
} from '../theme';

// Android needs this opt-in; iOS animates without it. Guarded so it runs once.
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

/** Short and eased — long enough to read the movement, not long enough to wait on. */
const MOVE_ANIM = {
  duration: 220,
  update: { type: LayoutAnimation.Types.easeInEaseOut },
  delete: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
  create: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
};

/** How long the just-moved row stays highlighted. */
const LANDED_MS = 1100;

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
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [landedId, setLandedId] = useState<string | null>(null);
  const landedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (landedTimer.current) clearTimeout(landedTimer.current);
    },
    [],
  );

  // The pick is held as an ID, not an index — the same reason the queue cursor is.
  // A removal or an external change can't leave it pointing at a different athlete.
  const picked = pickedId != null ? items.findIndex((it) => it.id === pickedId) : -1;
  const isPicking = picked >= 0;

  const flashLanded = (id: string) => {
    setLandedId(id);
    if (landedTimer.current) clearTimeout(landedTimer.current);
    landedTimer.current = setTimeout(() => setLandedId(null), LANDED_MS);
  };

  const move = (from: number, to: number, keepPicked: boolean) => {
    const id = items[from]?.id;
    if (id == null || to === from) return;
    LayoutAnimation.configureNext(MOVE_ANIM);
    onMove(from, to);
    if (!keepPicked) setPickedId(null);
    flashLanded(id);
  };

  const place = (slot: number) => {
    if (!isPicking) return;
    move(picked, slotToIndex(picked, slot), false);
  };

  // Nudge keeps the row picked, so "up three" is three taps on one control rather
  // than three pick-and-place cycles.
  const nudge = (delta: number) => {
    if (!isPicking) return;
    const to = picked + delta;
    if (to < 0 || to >= items.length) return;
    move(picked, to, true);
  };

  if (!items.length) return <Text style={styles.empty}>{emptyText}</Text>;

  return (
    <View>
      {isPicking ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText} numberOfLines={1}>
            Moving <Text style={styles.bannerName}>{items[picked]!.label}</Text>
          </Text>
          <Pressable onPress={() => setPickedId(null)} hitSlop={10}>
            <Text style={styles.bannerCancel}>Cancel</Text>
          </Pressable>
        </View>
      ) : (
        <Text style={styles.hint}>Tap an athlete to move them</Text>
      )}

      {items.map((it, i) => {
        const isPicked = i === picked;
        return (
          <View key={it.id}>
            <Slot active={isPicking} index={i} pickedIndex={picked} onPress={() => place(i)} />
            <Pressable
              onPress={() => setPickedId(isPicked ? null : it.id)}
              style={({ pressed }) => [
                styles.row,
                it.current && styles.rowCurrent,
                landedId === it.id && styles.rowLanded,
                isPicked && styles.rowPicked,
                // Dimming everything else makes the subject obvious with no motion.
                isPicking && !isPicked && styles.rowMuted,
                pressed && styles.dim,
              ]}
            >
              <Text style={[styles.pos, isPicked && styles.posPicked]}>{i + 1}</Text>
              <View style={styles.textCol}>
                <Text style={[styles.name, isPicked && styles.namePicked]} numberOfLines={1}>
                  {it.label}
                </Text>
                {it.sub ? (
                  <Text style={styles.sub} numberOfLines={1}>
                    {it.sub}
                  </Text>
                ) : null}
              </View>
              {it.current ? <Text style={styles.upNow}>UP</Text> : null}

              {isPicked ? (
                <View style={styles.nudgeGroup}>
                  <Pressable
                    onPress={() => nudge(-1)}
                    disabled={picked === 0}
                    hitSlop={6}
                    accessibilityLabel={`Move ${it.label} up one`}
                    style={({ pressed }) => [
                      styles.nudge,
                      (picked === 0 || pressed) && styles.dim,
                    ]}
                  >
                    <Text style={styles.nudgeText}>↑</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => nudge(1)}
                    disabled={picked === items.length - 1}
                    hitSlop={6}
                    accessibilityLabel={`Move ${it.label} down one`}
                    style={({ pressed }) => [
                      styles.nudge,
                      (picked === items.length - 1 || pressed) && styles.dim,
                    ]}
                  >
                    <Text style={styles.nudgeText}>↓</Text>
                  </Pressable>
                </View>
              ) : isPicking ? null : onRemove ? (
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
        );
      })}

      {/* The final slot, below the last row. */}
      <Slot
        active={isPicking}
        index={items.length}
        pickedIndex={picked}
        onPress={() => place(items.length)}
        last
      />
    </View>
  );
}

/**
 * A drop target between two rows.
 *
 * Only takes space while a move is live, so the list isn't permanently spaced out
 * by invisible gaps. It states the POSITION the athlete would take, which is the
 * difference between "tap somewhere and hope" and knowing where the tap lands.
 *
 * The two slots either side of the picked row mean "leave it where it is" and are
 * labelled as such rather than hidden — hiding them would reflow the list under
 * the finger mid-decision.
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
  pickedIndex: number;
  onPress: () => void;
  last?: boolean;
}) {
  if (!active) return <View style={last ? undefined : styles.gap} />;
  const inert = index === pickedIndex || index === pickedIndex + 1;
  return (
    <Pressable
      onPress={onPress}
      disabled={inert}
      accessibilityRole="button"
      accessibilityLabel={inert ? 'Current position' : `Move to position ${slotToIndex(pickedIndex, index) + 1}`}
      style={({ pressed }) => [styles.slot, pressed && !inert && styles.slotPressed]}
    >
      <View style={[styles.slotLine, inert && styles.slotLineInert]} />
      <Text style={[styles.slotLabel, inert && styles.slotLabelInert]}>
        {inert ? 'here now' : `→ ${slotToIndex(pickedIndex, index) + 1}`}
      </Text>
      <View style={[styles.slotLine, inert && styles.slotLineInert]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  empty: { color: '#64748b', fontSize: 13, textAlign: 'center', paddingVertical: 22, lineHeight: 19 },
  hint: { color: '#475569', fontSize: 11, marginBottom: 8 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    backgroundColor: '#16233a',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#1d4ed8',
  },
  bannerText: { color: INTERACTIVE_SOFT, fontSize: 12, flex: 1 },
  bannerName: { fontWeight: '800', color: '#dbeafe' },
  bannerCancel: { color: INTERACTIVE, fontSize: 13, fontWeight: '800' },
  gap: { height: 8 },
  // 40pt: a real target between two rows, and tall enough that the label reads.
  slot: {
    height: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 4,
  },
  slotPressed: { opacity: 0.55 },
  slotLine: { flex: 1, height: 2, borderRadius: 1, backgroundColor: INTERACTIVE_STRONG },
  slotLineInert: { backgroundColor: '#1c2432' },
  slotLabel: { color: INTERACTIVE, fontSize: 11, fontWeight: '800', fontVariant: ['tabular-nums'] },
  slotLabelInert: { color: '#334155', fontWeight: '600' },
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
  rowCurrent: { borderColor: INTERACTIVE_STRONG },
  rowMuted: { opacity: 0.4 },
  rowPicked: { borderColor: INTERACTIVE, backgroundColor: '#16233a', borderWidth: 2 },
  rowLanded: { borderColor: INTERACTIVE, backgroundColor: INTERACTIVE_ON_BG },
  pos: {
    color: '#475569',
    fontSize: 12,
    fontWeight: '800',
    width: 18,
    fontVariant: ['tabular-nums'],
  },
  posPicked: { color: INTERACTIVE },
  textCol: { flex: 1, minWidth: 0 },
  name: { color: '#e2e8f0', fontSize: 15, fontWeight: '700' },
  namePicked: { color: '#fff' },
  sub: { color: '#64748b', fontSize: 11, marginTop: 2 },
  upNow: { color: INTERACTIVE, fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
  nudgeGroup: { flexDirection: 'row', gap: 6 },
  nudge: {
    width: 38,
    height: 38,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#1d4ed8',
    backgroundColor: '#0b1220',
  },
  nudgeText: { color: INTERACTIVE_SOFT, fontSize: 17, fontWeight: '800' },
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
