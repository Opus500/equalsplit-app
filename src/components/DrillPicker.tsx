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
  Alert,
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

import {
  deleteDrillIfUnused,
  deleteDrillUnlabellingRuns,
  findOrCreateDrill,
  listDrills,
  renameDrill,
  type Drill,
} from '../db/database';
import { ENGINE_DRILL_LABELS, foldName } from '../db/migrations';
import {
  CAUTION,
  DESTRUCTIVE,
  INTERACTIVE,
  INTERACTIVE_SOFT,
  INTERACTIVE_STRONG,
} from '../theme';

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
  // Management is off by default: picking a drill is the common action and must
  // stay a single tap. Manage turns the rows into rename/delete controls.
  const [managing, setManaging] = useState(false);
  const [renaming, setRenaming] = useState<Drill | null>(null);

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
    setManaging(false);
    setRenaming(null);
    load();
  }, [visible, load]);

  // Engine drills (L Drill, Shuttle Run, Standalone) are owned by the Drills engine,
  // which writes by LABEL. Renaming one would orphan the series — the next rep would
  // mint a fresh record under the old name — so management is refused for them.
  // They only appear here at all when kind='all' (History re-tagging).
  const isEngineOwned = useCallback(
    (d: Drill) =>
      d.kind === 'engine' || ENGINE_DRILL_LABELS.some((l) => foldName(l) === foldName(d.name)),
    [],
  );

  const doDelete = useCallback(
    (d: Drill) => {
      if (d.run_count === 0) {
        // Nothing to orphan — delete outright.
        Alert.alert('Delete drill', `Delete “${d.name}”? It has no runs.`, [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: async () => {
              await deleteDrillIfUnused(d.id);
              if (d.id === currentId) onPick(null);
              await load();
            },
          },
        ]);
        return;
      }
      Alert.alert(
        'Delete drill',
        `“${d.name}” has ${d.run_count} run${d.run_count === 1 ? '' : 's'}.\n\n` +
          `The run${d.run_count === 1 ? '' : 's'} are kept and stay in History, but lose this ` +
          'label and drop out of the progression graphs.\n\nRename instead if this was a typo.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: `Delete, keep ${d.run_count} run${d.run_count === 1 ? '' : 's'}`,
            style: 'destructive',
            onPress: async () => {
              await deleteDrillUnlabellingRuns(d.id);
              if (d.id === currentId) onPick(null);
              await load();
            },
          },
        ],
      );
    },
    [currentId, onPick, load],
  );

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
              {!managing ? (
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
              ) : null}
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
                  selected={!managing && d.id === currentId}
                  onPress={() => {
                    if (managing) return;
                    onPick(d);
                    onClose();
                  }}
                  manage={
                    managing
                      ? isEngineOwned(d)
                        ? { locked: 'set by drill mode' }
                        : { onRename: () => setRenaming(d), onDelete: () => doDelete(d) }
                      : undefined
                  }
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

            <View style={styles.footRow}>
              <Pressable
                onPress={onClose}
                style={({ pressed }) => [styles.close, styles.footBtn, pressed && styles.dim]}
              >
                <Text style={styles.closeText}>Cancel</Text>
              </Pressable>
              {drills.length ? (
                <Pressable
                  onPress={() => setManaging((v) => !v)}
                  style={({ pressed }) => [
                    styles.close,
                    styles.footBtn,
                    managing && styles.manageOn,
                    pressed && styles.dim,
                  ]}
                >
                  <Text style={[styles.closeText, managing && styles.manageOnText]}>
                    {managing ? 'Done' : 'Manage'}
                  </Text>
                </Pressable>
              ) : null}
            </View>

            <RenameDrillPrompt
              drill={renaming}
              existing={drills}
              onClose={() => setRenaming(null)}
              onDone={async () => {
                setRenaming(null);
                await load();
              }}
            />
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/**
 * Rename, with the merge case surfaced BEFORE it happens.
 *
 * A folded-name collision merges rather than blocking: the case this exists for is
 * fixing a typo ("gs" -> "10m start"), and the correct target usually already
 * exists — blocking there would leave the typo permanent. Because a merge moves
 * runs and drops a record, it is stated explicitly with both counts first.
 */
function RenameDrillPrompt({
  drill,
  existing,
  onClose,
  onDone,
}: {
  drill: Drill | null;
  existing: Drill[];
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(drill?.name ?? '');
  }, [drill]);

  const target = useMemo(() => {
    if (!drill) return null;
    const n = name.trim();
    if (!n) return null;
    const key = foldName(n);
    return existing.find((d) => d.id !== drill.id && foldName(d.name) === key) ?? null;
  }, [name, existing, drill]);

  const submit = useCallback(async () => {
    if (!drill || busy) return;
    const n = name.trim();
    if (!n || n === drill.name) {
      onClose();
      return;
    }
    const apply = async () => {
      setBusy(true);
      try {
        await renameDrill(drill.id, n);
        await onDone();
      } finally {
        setBusy(false);
      }
    };
    if (target) {
      Alert.alert(
        'Merge drills',
        `“${target.name}” already exists with ${target.run_count} run${
          target.run_count === 1 ? '' : 's'
        }.\n\n` +
          `${drill.run_count} run${drill.run_count === 1 ? '' : 's'} from “${drill.name}” will ` +
          `move into it and the two become one series. “${drill.name}” is removed.\n\n` +
          'No runs are deleted. This cannot be undone from the app.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Merge', style: 'destructive', onPress: apply },
        ],
      );
      return;
    }
    await apply();
  }, [drill, name, target, busy, onClose, onDone]);

  return (
    <Modal visible={drill != null} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <Pressable style={styles.backdrop} onPress={onClose}>
          <Pressable style={styles.card} onPress={() => {}}>
            <Text style={styles.cardTitle}>Rename drill</Text>
            <Text style={styles.renameHint}>
              Every run keeps this label and stays in the graphs — the record is the same, only
              its name changes.
            </Text>
            {/* NOT styles.addInput: that carries flex:1 for the picker's ROW, and
                in this column card flex:1 means flexBasis:0 on the HEIGHT, which
                collapsed the field to its padding — an invisible text box. */}
            <TextInput
              style={styles.renameInput}
              value={name}
              onChangeText={setName}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={submit}
              placeholder="Drill name"
              placeholderTextColor="#475569"
            />
            {target ? (
              <Text style={styles.dupNote}>
                “{target.name}” already exists — renaming will MERGE{' '}
                {drill?.run_count ?? 0} run{(drill?.run_count ?? 0) === 1 ? '' : 's'} into it.
              </Text>
            ) : null}
            <View style={styles.renameActions}>
              <Pressable
                onPress={onClose}
                style={({ pressed }) => [styles.close, styles.footBtn, pressed && styles.dim]}
              >
                <Text style={styles.closeText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={submit}
                disabled={!name.trim() || busy}
                style={({ pressed }) => [
                  styles.addBtn,
                  styles.footBtn,
                  (!name.trim() || busy || pressed) && styles.dim,
                ]}
              >
                <Text style={styles.addBtnText}>{target ? 'Merge' : 'Rename'}</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

type ManageProps =
  | { onRename: () => void; onDelete: () => void; locked?: undefined }
  | { locked: string; onRename?: undefined; onDelete?: undefined };

function Row({
  label,
  detail,
  badge,
  selected,
  muted,
  onPress,
  manage,
}: {
  label: string;
  detail?: string;
  badge?: string;
  selected?: boolean;
  muted?: boolean;
  onPress: () => void;
  manage?: ManageProps;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={manage != null}
      style={({ pressed }) => [
        styles.row,
        selected && styles.rowSelected,
        pressed && !manage && styles.dim,
      ]}
    >
      <View style={styles.rowText}>
        <Text style={[styles.rowLabel, muted && styles.rowLabelMuted]} numberOfLines={1}>
          {label}
          {badge ? <Text style={styles.badge}>  {badge}</Text> : null}
        </Text>
        {detail ? <Text style={styles.rowDetail}>{detail}</Text> : null}
      </View>

      {manage?.locked ? (
        <Text style={styles.locked}>{manage.locked}</Text>
      ) : manage ? (
        <>
          {/* Rename first: it is the answer to a typo, and the one that keeps
              every run's label intact. Delete is the destructive fallback. */}
          <Pressable
            onPress={manage.onRename}
            hitSlop={6}
            style={({ pressed }) => [styles.miniBtn, pressed && styles.dim]}
          >
            <Text style={styles.miniText}>Rename</Text>
          </Pressable>
          <Pressable
            onPress={manage.onDelete}
            hitSlop={6}
            style={({ pressed }) => [styles.miniBtn, pressed && styles.dim]}
          >
            <Text style={styles.miniDanger}>Delete</Text>
          </Pressable>
        </>
      ) : selected ? (
        <Text style={styles.check}>✓</Text>
      ) : null}
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
  dupNote: { color: CAUTION, fontSize: 11, marginTop: 6 },
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
  rowSelected: { borderColor: INTERACTIVE_STRONG, backgroundColor: '#12203a' },
  rowText: { flex: 1 },
  rowLabel: { color: '#e2e8f0', fontSize: 15, fontWeight: '700' },
  rowLabelMuted: { color: '#94a3b8', fontWeight: '600' },
  badge: { color: '#a855f7', fontSize: 10, fontWeight: '700' },
  rowDetail: { color: '#64748b', fontSize: 11, marginTop: 2 },
  check: { color: INTERACTIVE, fontSize: 18, fontWeight: '800' },
  more: { paddingVertical: 10, alignItems: 'center' },
  moreText: { color: INTERACTIVE, fontSize: 13, fontWeight: '700' },
  empty: { color: '#64748b', fontSize: 13, textAlign: 'center', paddingVertical: 16 },
  close: {
    marginTop: 12,
    backgroundColor: '#243042',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  closeText: { color: '#cbd5e1', fontWeight: '700' },
  footRow: { flexDirection: 'row', gap: 10 },
  footBtn: { flex: 1 },
  manageOn: { backgroundColor: '#1e3a5f' },
  manageOnText: { color: INTERACTIVE_SOFT },
  miniBtn: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#243042',
    backgroundColor: '#161b22',
  },
  miniText: { color: '#94a3b8', fontSize: 12, fontWeight: '700' },
  miniDanger: { color: DESTRUCTIVE, fontSize: 12, fontWeight: '700' },
  locked: { color: '#475569', fontSize: 10, fontStyle: 'italic', maxWidth: 92, textAlign: 'right' },
  renameHint: { color: '#64748b', fontSize: 12, lineHeight: 17, marginBottom: 10 },
  renameInput: {
    minHeight: 44,
    backgroundColor: '#0b0e13',
    color: '#fff',
    fontSize: 16,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: '#243042',
  },
  renameActions: { flexDirection: 'row', gap: 10 },
  dim: { opacity: 0.45 },
});
