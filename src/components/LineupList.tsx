// The whole lineup, in run order, for a screen with the room to show it.
//
// The UpNextStrip is the phone's answer: who is up, who is next, in one row,
// because a phone mid-rep has no space for more. A 13-inch iPad on a tripod has
// most of a screen spare under the readout, and the thing a coach standing at a
// gate wants in that space is the same list the strip abbreviates — everyone
// still to run, in the order they will run. So this is the strip, unfolded.
//
// SAME DATA, SAME ACTIONS. It reads roster.currentAthlete and roster.upNext —
// the exact calls the strip makes — and a tap does what picking someone from
// the strip's sheet does: roster.jumpTo. Nothing here computes attribution or
// touches a run; it is a second view of the queue, not a second queue.
//
// Only rendered on wide screens (see the Timer and Modes screens). It is never
// part of a phone layout, so a phone is unchanged by its existence.

import { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { useRoster } from '../roster/RosterProvider';
import { disambiguate } from '../roster/labels';
import { FAINT, INK, INTERACTIVE, LINE, MUTED, SURFACE, SURFACE_2 } from '../theme';

export function LineupList({
  style,
  /** True when the list sits in a fixed box and should scroll inside it; false
   *  when it rides a scrolling parent and should simply be as tall as it is. */
  scroll = true,
}: {
  style?: StyleProp<ViewStyle>;
  scroll?: boolean;
}) {
  const roster = useRoster();
  const current = roster.currentAthlete;
  // Everyone after the cursor, wrapping — upNext excludes whoever is up, so the
  // run order is the current athlete followed by these.
  const rest = roster.upNext(roster.queue.athleteIds.length);
  const order = useMemo(() => (current ? [current, ...rest] : rest), [current, rest]);
  const details = useMemo(() => disambiguate(order), [order]);

  const rows = order.map((a, i) => {
    const isUp = i === 0 && !!current;
    return (
      <Pressable
        key={a.id}
        onPress={() => roster.jumpTo(a.id)}
        style={({ pressed }) => [styles.row, isUp && styles.rowUp, pressed && styles.dim]}
        accessibilityLabel={`${a.display_name}${isUp ? ', up now' : `, ${i + 1} in the lineup`}`}
      >
        <Text style={[styles.idx, isUp && styles.idxUp]}>{i + 1}</Text>
        <Text style={[styles.name, isUp && styles.nameUp]} numberOfLines={1}>
          {a.display_name}
        </Text>
        {details.get(a.id) ? (
          <Text style={styles.detail} numberOfLines={1}>
            {details.get(a.id)}
          </Text>
        ) : null}
        {isUp ? <Text style={styles.upTag}>UP NOW</Text> : null}
      </Pressable>
    );
  });

  return (
    <View style={[styles.card, style]}>
      <View style={styles.head}>
        <Text style={styles.kicker}>LINEUP</Text>
        <Text style={styles.count}>
          {order.length ? `${order.length} athlete${order.length === 1 ? '' : 's'}` : ''}
        </Text>
      </View>
      {!order.length ? (
        <Text style={styles.empty}>Nobody in the lineup yet. Add athletes from the Roster.</Text>
      ) : scroll ? (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.rows}>
          {rows}
        </ScrollView>
      ) : (
        <View style={styles.rows}>{rows}</View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: SURFACE,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: LINE,
    padding: 12,
    gap: 8,
  },
  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  kicker: { color: FAINT, fontSize: 10, fontWeight: '800', letterSpacing: 0.8 },
  count: { color: FAINT, fontSize: 12 },
  scroll: { flexGrow: 0, flexShrink: 1 },
  rows: { gap: 4 },
  // 48pt rows: tapped standing at a gate, possibly gloved, like every other
  // mid-rep control.
  row: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: SURFACE_2,
  },
  rowUp: { borderWidth: 1, borderColor: INTERACTIVE },
  idx: { color: FAINT, fontSize: 13, width: 24, fontVariant: ['tabular-nums'] },
  idxUp: { color: INTERACTIVE },
  name: { color: INK, fontSize: 17, fontWeight: '600', flexShrink: 1 },
  nameUp: { fontWeight: '800' },
  detail: { color: MUTED, fontSize: 13, flexShrink: 1 },
  upTag: { marginLeft: 'auto', color: INTERACTIVE, fontSize: 10, fontWeight: '800', letterSpacing: 0.6 },
  empty: { color: FAINT, fontSize: 13, paddingVertical: 8 },
  dim: { opacity: 0.6 },
});
