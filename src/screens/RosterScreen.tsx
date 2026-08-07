// Roster: the athlete records runs are attributed to (docs/ROSTER.md).
//
// Athletes are ARCHIVED, never deleted — archiving hides them from pickers while
// their run history stays intact and attributed. That is why there is no delete
// button anywhere on this screen: deleting a person would orphan their times.
//
// Zero-run athletes are ordinary, not an error: the migration seeds names that
// were typed but never raced, so every count reads "no runs yet" rather than
// assuming history exists.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import { createAthlete, setAthleteArchived, updateAthlete, type Athlete } from '../db/database';
import { foldName } from '../db/migrations';
import { disambiguate, runCountLabel } from '../roster/labels';
import { useRoster } from '../roster/RosterProvider';

export default function RosterScreen() {
  // The provider is the single source: the strip and pickers read the same list,
  // so an edit here can't leave them showing a stale roster.
  const roster = useRoster();
  const all = roster.athletes;
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<Athlete | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => roster.refresh(), [roster]);

  // Pick up roster changes made elsewhere (e.g. quick-add from a picker).
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inQueue = useMemo(() => new Set(roster.queue.athleteIds), [roster.queue.athleteIds]);

  const active = useMemo(() => all.filter((a) => a.archived_at == null), [all]);
  const archived = useMemo(() => all.filter((a) => a.archived_at != null), [all]);
  const visible = showArchived ? all : active;
  // Disambiguate over exactly what's rendered: hiding archived athletes removes
  // them as a source of ambiguity, so the list shouldn't carry their clutter.
  const details = useMemo(() => disambiguate(visible), [visible]);

  const submitEdit = useCallback(
    async (name: string, group: string) => {
      if (!editing) return;
      await updateAthlete(editing.id, { displayName: name, groupName: group });
      setEditing(null);
      await load();
    },
    [editing, load],
  );

  const submitCreate = useCallback(
    async (name: string, group: string) => {
      await createAthlete(name, group);
      setCreating(false);
      await load();
    },
    [load],
  );

  const toggleArchive = useCallback(
    async (a: Athlete) => {
      await setAthleteArchived(a.id, a.archived_at == null);
      setEditing(null);
      await load();
    },
    [load],
  );

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Roster</Text>

      <View style={styles.summary}>
        <Text style={styles.summaryText}>
          {active.length} athlete{active.length === 1 ? '' : 's'}
          {archived.length ? ` · ${archived.length} archived` : ''}
          {inQueue.size ? ` · ${inQueue.size} in today's lineup` : ''}
        </Text>
        {archived.length ? (
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>Show archived</Text>
            <Switch
              value={showArchived}
              onValueChange={setShowArchived}
              trackColor={{ false: '#243042', true: '#1d4ed8' }}
              thumbColor="#e2e8f0"
            />
          </View>
        ) : null}
      </View>

      <Pressable
        onPress={() => setCreating(true)}
        style={({ pressed }) => [styles.addBtn, pressed && styles.dim]}
      >
        <Text style={styles.addBtnText}>＋  Add athlete</Text>
      </Pressable>

      <FlatList
        data={visible}
        keyExtractor={(a) => a.id}
        contentContainerStyle={{ paddingBottom: 24 }}
        ListEmptyComponent={
          <Text style={styles.empty}>
            No athletes yet. Add one, or tag a run and it will appear here.
          </Text>
        }
        renderItem={({ item }) => {
          const isArchived = item.archived_at != null;
          const detail = details.get(item.id);
          const queued = inQueue.has(item.id);
          return (
            <Pressable
              onPress={() => setEditing(item)}
              style={({ pressed }) => [styles.row, isArchived && styles.rowArchived, pressed && styles.dim]}
            >
              <View style={styles.rowText}>
                <Text style={styles.name} numberOfLines={1}>
                  {item.display_name}
                  {isArchived ? <Text style={styles.archTag}>  archived</Text> : null}
                </Text>
                <Text style={styles.sub} numberOfLines={1}>
                  {[detail, runCountLabel(item.run_count)].filter(Boolean).join(' · ')}
                </Text>
              </View>
              {/* Today's lineup. Archived athletes can't be added — they're out of
                  rotation by definition; the queue skips them anyway. */}
              {!isArchived ? (
                <Pressable
                  onPress={() =>
                    queued ? roster.removeAthleteFromQueue(item.id) : roster.addAthleteToQueue(item.id)
                  }
                  hitSlop={8}
                  style={({ pressed }) => [
                    styles.queueBtn,
                    queued && styles.queueBtnOn,
                    pressed && styles.dim,
                  ]}
                >
                  <Text style={[styles.queueBtnText, queued && styles.queueBtnTextOn]}>
                    {queued ? '✓ lineup' : '+ lineup'}
                  </Text>
                </Pressable>
              ) : null}
              <Text style={styles.chev}>›</Text>
            </Pressable>
          );
        }}
      />

      <AthleteFormModal
        visible={creating}
        title="Add athlete"
        existing={all}
        onClose={() => setCreating(false)}
        onSubmit={submitCreate}
      />
      <AthleteFormModal
        visible={editing != null}
        title="Edit athlete"
        athlete={editing}
        existing={all}
        onClose={() => setEditing(null)}
        onSubmit={submitEdit}
        onToggleArchive={editing ? () => toggleArchive(editing) : undefined}
      />
    </View>
  );
}

/**
 * Add/edit form. On a duplicate name it PROMPTS for a distinguishing detail
 * rather than just warning: "Jayden · added Jul 30 · #a4f2" is unreadable
 * mid-practice, so the coach's own word ("Varsity") is asked for first and the
 * date/id label exists only as the guaranteed-unique fallback if they decline.
 */
function AthleteFormModal({
  visible,
  title,
  athlete,
  existing,
  onClose,
  onSubmit,
  onToggleArchive,
}: {
  visible: boolean;
  title: string;
  athlete?: Athlete | null;
  existing: Athlete[];
  onClose: () => void;
  onSubmit: (name: string, group: string) => void | Promise<void>;
  onToggleArchive?: () => void;
}) {
  const [name, setName] = useState('');
  const [group, setGroup] = useState('');

  useEffect(() => {
    if (!visible) return;
    setName(athlete?.display_name ?? '');
    setGroup(athlete?.group_name ?? '');
  }, [visible, athlete]);

  const clash = useMemo(() => {
    const n = name.trim();
    if (!n) return null;
    const key = foldName(n);
    const others = existing.filter((a) => a.id !== athlete?.id && foldName(a.display_name) === key);
    return others.length ? others : null;
  }, [name, existing, athlete]);

  const canSave = name.trim().length > 0;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <Pressable style={styles.backdrop} onPress={onClose}>
          <Pressable style={styles.card} onPress={() => {}}>
            <Text style={styles.cardTitle}>{title}</Text>

            <Text style={styles.label}>Name</Text>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="Athlete name"
              placeholderTextColor="#475569"
              autoCapitalize="words"
              autoFocus={!athlete}
              returnKeyType="next"
            />

            <Text style={[styles.label, { marginTop: 14 }]}>
              Group / event {clash ? <Text style={styles.needed}>— needed to tell them apart</Text> : '(optional)'}
            </Text>
            <TextInput
              style={styles.input}
              value={group}
              onChangeText={setGroup}
              placeholder={clash ? 'e.g. Varsity, 100m, Year 9' : 'optional'}
              placeholderTextColor="#475569"
              returnKeyType="done"
              onSubmitEditing={() => canSave && onSubmit(name, group)}
            />
            {clash ? (
              <Text style={styles.clashNote}>
                {clash.length === 1 ? 'Another athlete' : `${clash.length} other athletes`} named “
                {clash[0].display_name}” already exist{clash.length === 1 ? 's' : ''}
                {clash[0].group_name ? ` (${clash[0].group_name})` : ''}. Adding another is fine —
                a group keeps them readable in every list. Leave it blank and they’ll be told apart
                by date instead.
              </Text>
            ) : null}

            {onToggleArchive && athlete ? (
              <Pressable
                onPress={onToggleArchive}
                style={({ pressed }) => [styles.archiveBtn, pressed && styles.dim]}
              >
                <Text style={styles.archiveText}>
                  {athlete.archived_at ? 'Restore to roster' : 'Archive'}
                </Text>
                <Text style={styles.archiveHint}>
                  {athlete.archived_at
                    ? 'Shows in pickers again.'
                    : `Hidden from pickers. ${runCountLabel(athlete.run_count)} kept.`}
                </Text>
              </Pressable>
            ) : null}

            <View style={styles.actions}>
              <Pressable onPress={onClose} style={({ pressed }) => [styles.btn, pressed && styles.dim]}>
                <Text style={styles.btnText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => canSave && onSubmit(name, group)}
                disabled={!canSave}
                style={({ pressed }) => [
                  styles.btn,
                  styles.btnPrimary,
                  (!canSave || pressed) && styles.dim,
                ]}
              >
                <Text style={[styles.btnText, styles.btnPrimaryText]}>Save</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0e1116', paddingTop: 56, paddingHorizontal: 16 },
  flex: { flex: 1 },
  title: { color: '#fff', fontSize: 22, fontWeight: '800', marginBottom: 8 },
  summary: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  summaryText: { color: '#8b98a9', fontSize: 13, flex: 1 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  switchLabel: { color: '#94a3b8', fontSize: 12 },
  addBtn: {
    backgroundColor: '#1d4ed8',
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
    marginVertical: 12,
  },
  addBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  empty: { color: '#64748b', marginTop: 28, textAlign: 'center', lineHeight: 20 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#161b22',
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
  },
  rowArchived: { opacity: 0.55 },
  rowText: { flex: 1 },
  name: { color: '#e2e8f0', fontSize: 16, fontWeight: '700' },
  archTag: { color: '#b4541f', fontSize: 11, fontWeight: '700' },
  sub: { color: '#64748b', fontSize: 12, marginTop: 3 },
  queueBtn: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: '#243042',
    marginRight: 6,
  },
  queueBtnOn: { backgroundColor: '#14532d', borderColor: '#16a34a' },
  queueBtnText: { color: '#64748b', fontSize: 11, fontWeight: '700' },
  queueBtnTextOn: { color: '#86efac' },
  chev: { color: '#475569', fontSize: 22 },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  card: { backgroundColor: '#161b22', borderRadius: 16, padding: 18 },
  cardTitle: { color: '#fff', fontSize: 17, fontWeight: '800', marginBottom: 12 },
  label: { color: '#94a3b8', fontSize: 13, fontWeight: '700', marginBottom: 6 },
  needed: { color: '#fbbf24', fontWeight: '600' },
  input: {
    backgroundColor: '#0b0e13',
    color: '#fff',
    fontSize: 16,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  clashNote: { color: '#fbbf24', fontSize: 11, lineHeight: 16, marginTop: 8 },
  archiveBtn: {
    marginTop: 16,
    backgroundColor: '#0b0e13',
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: '#243042',
  },
  archiveText: { color: '#fb923c', fontWeight: '700', fontSize: 14 },
  archiveHint: { color: '#64748b', fontSize: 11, marginTop: 3 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 18 },
  btn: { flex: 1, backgroundColor: '#243042', borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  btnText: { color: '#cbd5e1', fontWeight: '700' },
  btnPrimary: { backgroundColor: '#2563eb' },
  btnPrimaryText: { color: '#fff' },
  dim: { opacity: 0.45 },
});
