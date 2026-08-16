// Shared athlete picker. Used by History (reassign a run) and, later, the timer's
// up-next strip. One component so "two athletes with the same name are always
// distinguishable" is true everywhere by construction, not per-screen discipline.
//
// - Archived athletes are hidden, EXCEPT the run's current athlete: a run
//   attributed to someone since archived must still show who it belongs to.
// - "Unassigned" is a first-class choice, not an absence — a run can legitimately
//   have no athlete, and you must be able to put it back.
// - Quick-add is inline: mid-practice a new face shouldn't send you to another tab.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { createAthlete, listAthletes, type Athlete } from '../db/database';
import { disambiguate, runCountLabel } from '../roster/labels';
import { useRoster } from '../roster/RosterProvider';
import { foldName } from '../db/migrations';
import {
  CAUTION,
  EDITED,
  INTERACTIVE,
  INTERACTIVE_STRONG,
} from '../theme';

export function AthletePickerModal({
  visible,
  currentId,
  title = 'Choose athlete',
  allowUnassigned = true,
  onClose,
  onPick,
}: {
  visible: boolean;
  currentId: string | null;
  title?: string;
  allowUnassigned?: boolean;
  onClose: () => void;
  onPick: (athleteId: string | null) => void;
}) {
  const roster = useRoster();
  const [all, setAll] = useState<Athlete[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setAll(await listAthletes({ includeArchived: true }));
    } catch {
      setAll([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    setQuery('');
    setNewName('');
    load();
  }, [visible, load]);

  // Active roster, plus the current athlete even if archived (so the run's own
  // attribution is never invisible in its own picker).
  const selectable = useMemo(
    () => all.filter((a) => a.archived_at == null || a.id === currentId),
    [all, currentId],
  );
  const details = useMemo(() => disambiguate(selectable), [selectable]);
  const shown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    if (!q) return selectable;
    return selectable.filter(
      (a) =>
        a.display_name.toLocaleLowerCase().includes(q) ||
        (a.group_name ?? '').toLocaleLowerCase().includes(q),
    );
  }, [selectable, query]);

  // Warn (don't block) on a duplicate: same-name athletes are legitimate, they
  // just need telling apart — the roster screen is where the detail is prompted.
  const duplicate = useMemo(() => {
    const n = newName.trim();
    if (!n) return false;
    const key = foldName(n);
    return all.some((a) => foldName(a.display_name) === key);
  }, [newName, all]);

  const quickAdd = useCallback(async () => {
    const name = newName.trim();
    if (!name || adding) return;
    setAdding(true);
    try {
      const a = await createAthlete(name);
      // Refresh the provider BEFORE handing the id back: the strip resolves an
      // athlete through the provider's index, so picking someone it hasn't
      // loaded yet would read as "no athlete".
      await roster.refresh();
      onPick(a.id);
      onClose();
    } catch {
      /* ignore — name validation is the only failure mode */
    } finally {
      setAdding(false);
    }
  }, [newName, adding, onPick, onClose, roster]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <Pressable style={styles.backdrop} onPress={onClose}>
          <Pressable style={styles.card} onPress={() => {}}>
            <Text style={styles.cardTitle}>{title}</Text>

            <TextInput
              style={styles.search}
              value={query}
              onChangeText={setQuery}
              placeholder="Search"
              placeholderTextColor="#475569"
              autoCorrect={false}
              returnKeyType="search"
            />

            <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
              {allowUnassigned ? (
                <Row
                  label="Unassigned"
                  detail="no athlete on this run"
                  selected={currentId == null}
                  muted
                  onPress={() => {
                    onPick(null);
                    onClose();
                  }}
                />
              ) : null}

              {loading ? (
                <View style={styles.loading}>
                  <ActivityIndicator size="small" color={INTERACTIVE} />
                </View>
              ) : null}

              {!loading && shown.length === 0 ? (
                <Text style={styles.empty}>
                  {selectable.length === 0
                    ? 'No athletes yet — add one below.'
                    : 'No match. Try a different search.'}
                </Text>
              ) : null}

              {shown.map((a) => (
                <Row
                  key={a.id}
                  label={a.display_name}
                  // run count is shown so junk/duplicate records are obvious at a
                  // glance; zero-run athletes are normal, never an error state
                  detail={[details.get(a.id), runCountLabel(a.run_count)].filter(Boolean).join(' · ')}
                  archived={a.archived_at != null}
                  selected={a.id === currentId}
                  onPress={() => {
                    onPick(a.id);
                    onClose();
                  }}
                />
              ))}
            </ScrollView>

            <View style={styles.addRow}>
              <TextInput
                style={styles.addInput}
                value={newName}
                onChangeText={setNewName}
                placeholder="＋ New athlete"
                placeholderTextColor="#475569"
                autoCapitalize="words"
                returnKeyType="done"
                onSubmitEditing={quickAdd}
              />
              <Pressable
                onPress={quickAdd}
                disabled={!newName.trim() || adding}
                style={({ pressed }) => [
                  styles.addBtn,
                  (!newName.trim() || adding || pressed) && styles.dim,
                ]}
              >
                <Text style={styles.addBtnText}>Add</Text>
              </Pressable>
            </View>
            {duplicate ? (
              <Text style={styles.dupWarn}>
                Already in the roster. Adding a second one is fine — give them a group in Roster so
                you can tell them apart.
              </Text>
            ) : null}

            <Pressable onPress={onClose} style={({ pressed }) => [styles.close, pressed && styles.dim]}>
              <Text style={styles.closeText}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Row({
  label,
  detail,
  selected,
  archived,
  muted,
  onPress,
}: {
  label: string;
  detail?: string | null;
  selected?: boolean;
  archived?: boolean;
  muted?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, selected && styles.rowSelected, pressed && styles.rowPressed]}
    >
      <View style={styles.rowText}>
        <Text style={[styles.rowLabel, muted && styles.rowLabelMuted]} numberOfLines={1}>
          {label}
          {archived ? <Text style={styles.archTag}>  archived</Text> : null}
        </Text>
        {detail ? (
          <Text style={styles.rowDetail} numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
      </View>
      {selected ? <Text style={styles.check}>✓</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  card: { backgroundColor: '#161b22', borderRadius: 16, padding: 18, maxHeight: '86%' },
  cardTitle: { color: '#fff', fontSize: 17, fontWeight: '800', marginBottom: 10 },
  search: {
    backgroundColor: '#0b0e13',
    color: '#fff',
    fontSize: 15,
    borderRadius: 10,
    paddingVertical: 9,
    paddingHorizontal: 12,
  },
  list: { flexGrow: 0, marginTop: 10 },
  loading: { paddingVertical: 16, alignItems: 'center' },
  empty: { color: '#64748b', fontSize: 13, textAlign: 'center', paddingVertical: 18 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#0b0e13',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#243042',
  },
  rowSelected: { borderColor: INTERACTIVE_STRONG, backgroundColor: '#12203a' },
  rowPressed: { opacity: 0.7 },
  rowText: { flex: 1 },
  rowLabel: { color: '#e2e8f0', fontSize: 16, fontWeight: '700' },
  rowLabelMuted: { color: '#94a3b8', fontWeight: '600' },
  rowDetail: { color: '#64748b', fontSize: 12, marginTop: 2 },
  archTag: { color: EDITED, fontSize: 11, fontWeight: '700' },
  check: { color: INTERACTIVE, fontSize: 18, fontWeight: '800' },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  addInput: {
    flex: 1,
    backgroundColor: '#0b0e13',
    color: '#fff',
    fontSize: 15,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  addBtn: { backgroundColor: '#2563eb', borderRadius: 10, paddingHorizontal: 16, paddingVertical: 11 },
  addBtnText: { color: '#fff', fontWeight: '700' },
  dupWarn: { color: CAUTION, fontSize: 11, lineHeight: 16, marginTop: 8 },
  close: {
    marginTop: 12,
    backgroundColor: '#243042',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  closeText: { color: '#cbd5e1', fontWeight: '700' },
  dim: { opacity: 0.45 },
});
