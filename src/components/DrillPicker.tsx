// Drill picker, backed by drill RECORDS (schema v3).
//
// Ordering is by last used, which is the whole clutter strategy: a drill tried
// once ("sled push") sinks below the ones actually in rotation and eventually
// falls behind "More…", without any archive state for the coach to manage. The
// list is capped so the common case is a single glance, never a scroll.
//
// `kind` scopes the vocabulary: the timers show 'manual' only, so L Drill and
// Shuttle Run — written by the Drills engine — never clutter a Mode-1 run's
// labels. History passes 'all' because re-tagging may legitimately target either.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
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

import { findOrCreateDrill, listDrills, type Drill } from '../db/database';
import { foldName } from '../db/migrations';

const VISIBLE_CAP = 8;

export function DrillPickerModal({
  visible,
  currentId,
  kind = 'manual',
  title = 'Drill',
  onClose,
  onPick,
}: {
  visible: boolean;
  currentId: string | null;
  kind?: 'manual' | 'engine' | 'all';
  title?: string;
  onClose: () => void;
  onPick: (drill: Drill | null) => void;
}) {
  const [drills, setDrills] = useState<Drill[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      setDrills(await listDrills({ kind }));
    } catch {
      setDrills([]);
    }
  }, [kind]);

  useEffect(() => {
    if (!visible) return;
    setNewName('');
    setExpanded(false);
    load();
  }, [visible, load]);

  // The current drill must always be visible even if it has sunk below the cap —
  // otherwise the selected item is missing from its own picker.
  const shown = useMemo(() => {
    if (expanded || drills.length <= VISIBLE_CAP) return drills;
    const head = drills.slice(0, VISIBLE_CAP);
    const cur = drills.find((d) => d.id === currentId);
    return cur && !head.some((d) => d.id === cur.id) ? [...head, cur] : head;
  }, [drills, expanded, currentId]);

  const duplicate = useMemo(() => {
    const n = newName.trim();
    if (!n) return null;
    const key = foldName(n);
    return drills.find((d) => foldName(d.name) === key) ?? null;
  }, [newName, drills]);

  const add = useCallback(async () => {
    const name = newName.trim();
    if (!name || adding) return;
    // A folded match joins the existing drill rather than forking it — the same
    // rule the migration used, so retyping "30M" can't split the series.
    if (duplicate) {
      onPick(duplicate);
      onClose();
      return;
    }
    setAdding(true);
    try {
      const d = await findOrCreateDrill(name);
      if (d) {
        onPick(d);
        onClose();
      }
    } finally {
      setAdding(false);
    }
  }, [newName, adding, duplicate, onPick, onClose]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <Pressable style={styles.backdrop} onPress={onClose}>
          <Pressable style={styles.card} onPress={() => {}}>
            <Text style={styles.cardTitle}>{title}</Text>

            {/* Add is at the TOP and commits from the keyboard's return key, so a
                new label can always be saved without reaching a button that the
                keyboard may be covering. */}
            <View style={styles.addRow}>
              <TextInput
                style={styles.addInput}
                value={newName}
                onChangeText={setNewName}
                placeholder="＋ New drill name"
                placeholderTextColor="#475569"
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="done"
                onSubmitEditing={add}
                blurOnSubmit
              />
              <Pressable
                onPress={add}
                disabled={!newName.trim() || adding}
                style={({ pressed }) => [
                  styles.addBtn,
                  (!newName.trim() || adding || pressed) && styles.dim,
                ]}
              >
                <Text style={styles.addBtnText}>{duplicate ? 'Use' : 'Add'}</Text>
              </Pressable>
            </View>
            {duplicate ? (
              <Text style={styles.dupNote}>“{duplicate.name}” already exists — this will use it.</Text>
            ) : null}

            <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
              <Row
                label="No drill"
                detail="untagged"
                muted
                selected={currentId == null}
                onPress={() => {
                  onPick(null);
                  onClose();
                }}
              />
              {shown.map((d) => (
                <Row
                  key={d.id}
                  label={d.name}
                  detail={
                    d.run_count > 0
                      ? `${d.run_count} run${d.run_count === 1 ? '' : 's'}`
                      : 'not used yet'
                  }
                  badge={kind === 'all' && d.kind === 'engine' ? 'drill mode' : undefined}
                  selected={d.id === currentId}
                  onPress={() => {
                    onPick(d);
                    onClose();
                  }}
                />
              ))}
              {!expanded && drills.length > VISIBLE_CAP ? (
                <Pressable onPress={() => setExpanded(true)} style={styles.more}>
                  <Text style={styles.moreText}>
                    More… ({drills.length - VISIBLE_CAP} less-used)
                  </Text>
                </Pressable>
              ) : null}
              {drills.length === 0 ? (
                <Text style={styles.empty}>No drills yet — add one above.</Text>
              ) : null}
            </ScrollView>

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
  badge,
  selected,
  muted,
  onPress,
}: {
  label: string;
  detail?: string;
  badge?: string;
  selected?: boolean;
  muted?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, selected && styles.rowSelected, pressed && styles.dim]}
    >
      <View style={styles.rowText}>
        <Text style={[styles.rowLabel, muted && styles.rowLabelMuted]} numberOfLines={1}>
          {label}
          {badge ? <Text style={styles.badge}>  {badge}</Text> : null}
        </Text>
        {detail ? <Text style={styles.rowDetail}>{detail}</Text> : null}
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
  card: { backgroundColor: '#161b22', borderRadius: 16, padding: 18, maxHeight: '84%' },
  cardTitle: { color: '#fff', fontSize: 17, fontWeight: '800', marginBottom: 12 },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
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
  dupNote: { color: '#fbbf24', fontSize: 11, marginTop: 6 },
  list: { flexGrow: 0, marginTop: 10 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#0b0e13',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#243042',
  },
  rowSelected: { borderColor: '#3b82f6', backgroundColor: '#12203a' },
  rowText: { flex: 1 },
  rowLabel: { color: '#e2e8f0', fontSize: 15, fontWeight: '700' },
  rowLabelMuted: { color: '#94a3b8', fontWeight: '600' },
  badge: { color: '#a855f7', fontSize: 10, fontWeight: '700' },
  rowDetail: { color: '#64748b', fontSize: 11, marginTop: 2 },
  check: { color: '#34d399', fontSize: 18, fontWeight: '800' },
  more: { paddingVertical: 10, alignItems: 'center' },
  moreText: { color: '#60a5fa', fontSize: 13, fontWeight: '700' },
  empty: { color: '#64748b', fontSize: 13, textAlign: 'center', paddingVertical: 16 },
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
