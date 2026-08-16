// One editor for both the live lineup and a saved template.
//
// It owns no ordering logic — it renders ReorderList and hands moves back to the
// caller, so the live queue persists through RosterProvider (cursor semantics and
// undo invalidation intact) while a template edits a local array and saves on Done.
// Same component, two persistence strategies, no duplicated slot maths.

import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useRoster } from '../roster/RosterProvider';
import { disambiguate, runCountLabel } from '../roster/labels';
import { ReorderList } from './ReorderList';
import {
  INTERACTIVE,
} from '../theme';

export function LineupEditorModal({
  visible,
  title,
  athleteIds,
  currentId,
  onMove,
  onRemove,
  onClose,
  footer,
  note,
}: {
  visible: boolean;
  title: string;
  athleteIds: string[];
  /** the athlete currently up — only meaningful for the live lineup */
  currentId?: string | null;
  onMove: (from: number, to: number) => void;
  onRemove?: (id: string) => void;
  onClose: () => void;
  footer?: React.ReactNode;
  note?: string;
}) {
  const roster = useRoster();

  // Resolve through the roster so a renamed athlete shows their current name, and
  // an id with no record left (should not happen) is dropped rather than crashing.
  const athletes = athleteIds.map((id) => roster.byId(id)).filter((a) => a != null);
  const details = disambiguate(athletes);

  const items = athletes.map((a) => ({
    id: a.id,
    label: a.display_name,
    sub: [
      a.archived_at ? 'archived' : null,
      details.get(a.id),
      runCountLabel(a.run_count),
    ]
      .filter(Boolean)
      .join(' · '),
    current: currentId != null && a.id === currentId,
  }));

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet">
      <View style={styles.container}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
            <Text style={styles.sub}>
              {items.length} athlete{items.length === 1 ? '' : 's'}
            </Text>
          </View>
          <Pressable onPress={onClose} hitSlop={10} style={({ pressed }) => pressed && styles.dim}>
            <Text style={styles.done}>Done</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.body}>
          {note ? <Text style={styles.note}>{note}</Text> : null}
          <ReorderList
            items={items}
            onMove={onMove}
            onRemove={onRemove}
            emptyText={
              onRemove
                ? 'Nobody in the lineup yet. Add athletes with “+ lineup” on the roster.'
                : 'This template has no athletes.'
            }
          />
          {footer}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0e1116' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#243042',
  },
  headerText: { flex: 1, minWidth: 0 },
  title: { color: '#fff', fontSize: 19, fontWeight: '800' },
  sub: { color: '#64748b', fontSize: 12, marginTop: 3 },
  done: { color: INTERACTIVE, fontSize: 15, fontWeight: '800' },
  body: { padding: 16, paddingBottom: 40 },
  note: { color: '#64748b', fontSize: 12, lineHeight: 18, marginBottom: 14 },
  dim: { opacity: 0.5 },
});
