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
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { AthleteDetailModal } from '../components/AthleteDetail';
import { LineupEditorModal } from '../components/LineupEditor';
import { TemplateManagerModal } from '../components/TemplateManager';
import { createAthlete, setAthleteArchived, updateAthlete, type Athlete } from '../db/database';
import { foldName } from '../db/migrations';
import { disambiguate, runCountLabel } from '../roster/labels';
import { useRoster } from '../roster/RosterProvider';
import {
  CAUTION,
  DESTRUCTIVE,
  DESTRUCTIVE_EDGE,
  INTERACTIVE_ON_BG,
  INTERACTIVE_SOFT,
  INTERACTIVE_STRONG,
} from '../theme';

export default function RosterScreen() {
  // The provider is the single source: the strip and pickers read the same list,
  // so an edit here can't leave them showing a stale roster.
  const roster = useRoster();
  const all = roster.athletes;
  const [archivedOpen, setArchivedOpen] = useState(false);
  // Tapping a row opens the DETAIL view (progress); editing is a button inside it.
  const [viewing, setViewing] = useState<Athlete | null>(null);
  const [editing, setEditing] = useState<Athlete | null>(null);
  const [creating, setCreating] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [lineupOpen, setLineupOpen] = useState(false);

  const load = useCallback(() => roster.refresh(), [roster]);

  // Pick up roster changes made elsewhere (e.g. quick-add from a picker).
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inQueue = useMemo(() => new Set(roster.queue.athleteIds), [roster.queue.athleteIds]);

  const active = useMemo(() => all.filter((a) => a.archived_at == null), [all]);
  const archived = useMemo(() => all.filter((a) => a.archived_at != null), [all]);
  // Archived athletes live in a collapsed section at the BOTTOM rather than
  // behind a toggle: the roster reads as one list you scroll to the end of, and
  // the section header states how many are down there instead of hiding the fact.
  const visible = useMemo(
    () => (archivedOpen ? [...active, ...archived] : active),
    [active, archived, archivedOpen],
  );
  // Disambiguate over exactly what's rendered: collapsing the archived section
  // removes them as a source of ambiguity, so the list drops their clutter too.
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

  // The detail sheet holds a snapshot, so after an edit it would keep showing the
  // old name until reopened. Re-resolve it from the refreshed list instead.
  const viewingLive = useMemo(
    () => (viewing ? (all.find((a) => a.id === viewing.id) ?? viewing) : null),
    [viewing, all],
  );

  const submitCreate = useCallback(
    async (name: string, group: string) => {
      await createAthlete(name, group);
      setCreating(false);
      await load();
    },
    [load],
  );

  // Session-scoped: clearQueue() writes an empty live queue and nothing else.
  // Templates are separate rows in queue_templates, and no run references the
  // lineup — so this can't reach either. The confirm says so, because "clear"
  // next to a list of names reads like it might delete the people.
  const confirmClearLineup = useCallback(() => {
    const n = roster.queue.athleteIds.length;
    if (!n) return;
    Alert.alert(
      'Clear lineup?',
      `Removes all ${n} athlete${n === 1 ? '' : 's'} from today's lineup.\n\n` +
        'Nobody is deleted, no runs are affected, and saved templates are untouched — ' +
        'this only empties the running order.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear lineup',
          style: 'destructive',
          onPress: () => {
            roster.clearQueue();
            setLineupOpen(false);
          },
        },
      ],
    );
  }, [roster]);

  const toggleArchive = useCallback(
    async (a: Athlete) => {
      await setAthleteArchived(a.id, a.archived_at == null);
      setEditing(null);
      setViewing(null);
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
          {inQueue.size ? ` · ${inQueue.size} in today's lineup` : ''}
        </Text>
        {inQueue.size ? (
          <Pressable
            onPress={() => setLineupOpen(true)}
            hitSlop={8}
            style={({ pressed }) => [styles.tmplBtn, pressed && styles.dim]}
          >
            <Text style={styles.tmplBtnText}>Order</Text>
          </Pressable>
        ) : null}
        <Pressable
          onPress={() => setTemplatesOpen(true)}
          hitSlop={8}
          style={({ pressed }) => [styles.tmplBtn, pressed && styles.dim]}
        >
          <Text style={styles.tmplBtnText}>Templates</Text>
        </Pressable>
      </View>

      <Pressable
        onPress={() => setCreating(true)}
        style={({ pressed }) => [styles.addBtn, pressed && styles.dim]}
      >
        <Text style={styles.addBtnText}>＋  Add athlete</Text>
      </Pressable>

      <FlatList
        data={active}
        keyExtractor={(a) => a.id}
        contentContainerStyle={{ paddingBottom: 24 }}
        ListEmptyComponent={
          <Text style={styles.empty}>
            No athletes yet. Add one, or tag a run and it will appear here.
          </Text>
        }
        renderItem={({ item }) => (
          <AthleteRow
            athlete={item}
            detail={details.get(item.id)}
            queued={inQueue.has(item.id)}
            onPress={() => setViewing(item)}
            onToggleQueue={() =>
              inQueue.has(item.id)
                ? roster.removeAthleteFromQueue(item.id)
                : roster.addAthleteToQueue(item.id)
            }
          />
        )}
        /* Archived athletes sit in a collapsed section at the BOTTOM of the
           same list, not behind a toggle: the count is always stated, and
           expanding shows them styled distinctly so it is obvious at a glance
           why they are missing from every picker. */
        ListFooterComponent={
          archived.length ? (
            <View>
              <Pressable
                onPress={() => setArchivedOpen((v) => !v)}
                style={({ pressed }) => [styles.archHeader, pressed && styles.dim]}
              >
                <Text style={styles.archHeaderText}>
                  {archivedOpen ? '▾' : '▸'}  Archived ({archived.length})
                </Text>
                <Text style={styles.archHeaderHint}>
                  {archivedOpen ? 'hidden from every picker · runs kept' : 'tap to show'}
                </Text>
              </Pressable>
              {archivedOpen
                ? archived.map((a) => (
                    <AthleteRow
                      key={a.id}
                      athlete={a}
                      detail={details.get(a.id)}
                      queued={false}
                      onPress={() => setViewing(a)}
                    />
                  ))
                : null}
            </View>
          ) : null
        }
      />

      {/* Detail (progress) is what a row tap opens; the edit form is NESTED inside
          it, not a sibling — see the note on AthleteDetailModal's children prop. */}
      <AthleteDetailModal
        visible={viewingLive != null}
        athlete={viewingLive}
        onClose={() => setViewing(null)}
        onEdit={() => viewingLive && setEditing(viewingLive)}
      >
        <AthleteFormModal
          visible={editing != null}
          title="Edit athlete"
          athlete={editing}
          existing={all}
          onClose={() => setEditing(null)}
          onSubmit={submitEdit}
          onToggleArchive={editing ? () => toggleArchive(editing) : undefined}
        />
      </AthleteDetailModal>

      <AthleteFormModal
        visible={creating}
        title="Add athlete"
        existing={all}
        onClose={() => setCreating(false)}
        onSubmit={submitCreate}
      />

      {/* Live lineup order. Moves go through RosterProvider, so the cursor keeps
          tracking the ATHLETE and a reorder invalidates a pending skip undo. */}
      <LineupEditorModal
        visible={lineupOpen}
        title="Lineup order"
        athleteIds={roster.queue.athleteIds}
        currentId={roster.currentAthlete?.id ?? null}
        onMove={roster.moveInQueue}
        onRemove={roster.removeAthleteFromQueue}
        onClose={() => setLineupOpen(false)}
        note="Whoever is UP keeps their turn wherever you move them — the cursor follows the athlete, not the position."
        footer={
          roster.queue.athleteIds.length ? (
            <Pressable
              onPress={confirmClearLineup}
              style={({ pressed }) => [styles.clearBtn, pressed && styles.dim]}
            >
              <Text style={styles.clearBtnText}>Clear lineup</Text>
              <Text style={styles.clearBtnHint}>
                Empties today’s lineup only. Saved templates and every run are untouched.
              </Text>
            </Pressable>
          ) : null
        }
      />

      <TemplateManagerModal visible={templatesOpen} onClose={() => setTemplatesOpen(false)} />
    </View>
  );
}

/** One roster row. Shared by the active list and the archived section so the two
 *  can't drift apart; archived rows are deliberately styled distinctly (dimmed,
 *  struck name, explicit tag, no lineup button) so it reads as a different state
 *  rather than a normal athlete that happens to be lower down. */
function AthleteRow({
  athlete,
  detail,
  queued,
  onPress,
  onToggleQueue,
}: {
  athlete: Athlete;
  detail?: string | null;
  queued: boolean;
  onPress: () => void;
  onToggleQueue?: () => void;
}) {
  const isArchived = athlete.archived_at != null;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, isArchived && styles.rowArchived, pressed && styles.dim]}
    >
      <View style={styles.rowText}>
        <Text style={[styles.name, isArchived && styles.nameArchived]} numberOfLines={1}>
          {athlete.display_name}
        </Text>
        <Text style={styles.sub} numberOfLines={1}>
          {[isArchived ? 'archived' : null, detail, runCountLabel(athlete.run_count)]
            .filter(Boolean)
            .join(' · ')}
        </Text>
      </View>
      {/* Archived athletes get no lineup button — they're out of rotation by
          definition, and the queue skips them anyway. */}
      {!isArchived && onToggleQueue ? (
        <Pressable
          onPress={onToggleQueue}
          hitSlop={8}
          style={({ pressed }) => [styles.queueBtn, queued && styles.queueBtnOn, pressed && styles.dim]}
        >
          <Text style={[styles.queueBtnText, queued && styles.queueBtnTextOn]}>
            {queued ? '✓ lineup' : '+ lineup'}
          </Text>
        </Pressable>
      ) : null}
      <Text style={styles.chev}>›</Text>
    </Pressable>
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
  tmplBtn: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#243042',
  },
  tmplBtnText: { color: '#94a3b8', fontSize: 12, fontWeight: '700' },
  clearBtn: {
    marginTop: 28,
    backgroundColor: '#1a1214',
    borderWidth: 1,
    borderColor: '#7f1d1d',
    borderRadius: 10,
    paddingVertical: 13,
    paddingHorizontal: 14,
  },
  clearBtnText: { color: DESTRUCTIVE, fontSize: 14, fontWeight: '800' },
  clearBtnHint: { color: '#64748b', fontSize: 11, lineHeight: 16, marginTop: 4 },
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
  rowArchived: {
    opacity: 0.6,
    backgroundColor: '#12151b',
    borderLeftWidth: 3,
    borderLeftColor: DESTRUCTIVE_EDGE,
  },
  rowText: { flex: 1 },
  name: { color: '#e2e8f0', fontSize: 16, fontWeight: '700' },
  nameArchived: { color: '#94a3b8', textDecorationLine: 'line-through' },
  archHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 4,
    marginTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#243042',
  },
  archHeaderText: { color: '#94a3b8', fontSize: 13, fontWeight: '800' },
  archHeaderHint: { color: '#64748b', fontSize: 11 },
  sub: { color: '#64748b', fontSize: 12, marginTop: 3 },
  queueBtn: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: '#243042',
    marginRight: 6,
  },
  queueBtnOn: { backgroundColor: INTERACTIVE_ON_BG, borderColor: INTERACTIVE_STRONG },
  queueBtnText: { color: '#64748b', fontSize: 11, fontWeight: '700' },
  queueBtnTextOn: { color: INTERACTIVE_SOFT },
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
  needed: { color: CAUTION, fontWeight: '600' },
  input: {
    backgroundColor: '#0b0e13',
    color: '#fff',
    fontSize: 16,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  clashNote: { color: CAUTION, fontSize: 11, lineHeight: 16, marginTop: 8 },
  archiveBtn: {
    marginTop: 16,
    backgroundColor: '#0b0e13',
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: '#243042',
  },
  archiveText: { color: DESTRUCTIVE, fontWeight: '700', fontSize: 14 },
  archiveHint: { color: '#64748b', fontSize: 11, marginTop: 3 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 18 },
  btn: { flex: 1, backgroundColor: '#243042', borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  btnText: { color: '#cbd5e1', fontWeight: '700' },
  btnPrimary: { backgroundColor: '#2563eb' },
  btnPrimaryText: { color: '#fff' },
  dim: { opacity: 0.45 },
});
