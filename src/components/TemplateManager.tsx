// Queue templates: named lineups built ahead of practice.
//
// Loading one REPLACES the live lineup — it is "today's lineup is this group",
// not "add these people". Appending would silently grow a lineup every time a
// coach re-loaded the same template.
//
// Because it replaces, it can destroy work. If the current lineup already has runs
// against it today, loading confirms first and says how many. A lineup wiped
// mid-practice with no warning is the kind of thing that makes a coach stop
// trusting the feature.

import { useCallback, useEffect, useState } from 'react';
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
  countTodayRunsForAthletes,
  createTemplate,
  deleteTemplate,
  listTemplates,
  updateTemplate,
  type QueueTemplate,
} from '../db/database';
import { useRoster } from '../roster/RosterProvider';

export function TemplateManagerModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const roster = useRoster();
  const [templates, setTemplates] = useState<QueueTemplate[]>([]);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setTemplates(await listTemplates());
    } catch {
      /* keep what we have */
    }
  }, []);

  useEffect(() => {
    if (visible) load();
  }, [visible, load]);

  const current = roster.queue.athleteIds;

  const doLoad = useCallback(
    async (t: QueueTemplate) => {
      if (busy) return;
      setBusy(true);
      try {
        // Only ask when there is something to lose: a lineup with runs already
        // recorded against it TODAY. An empty or untouched lineup loads silently,
        // because a confirm nobody needs is a confirm everybody learns to dismiss.
        const atRisk = await countTodayRunsForAthletes(current);
        if (atRisk > 0) {
          const names = roster.currentAthlete?.display_name;
          Alert.alert(
            'Replace the current lineup?',
            `${atRisk} run${atRisk === 1 ? '' : 's'} recorded against this lineup today.\n\n` +
              `Loading “${t.name}” replaces the ${current.length} athlete${
                current.length === 1 ? '' : 's'
              } currently lined up${names ? ` (${names} is up)` : ''}. ` +
              'Those runs are kept — only the lineup changes.',
            [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Replace',
                style: 'destructive',
                onPress: () => {
                  roster.loadTemplate(t.athleteIds);
                  onClose();
                },
              },
            ],
          );
          return;
        }
        roster.loadTemplate(t.athleteIds);
        onClose();
      } finally {
        setBusy(false);
      }
    },
    [busy, current, roster, onClose],
  );

  const doSaveNew = useCallback(async () => {
    const name = newName.trim();
    if (!name || !current.length) return;
    await createTemplate(name, current);
    setNewName('');
    await load();
  }, [newName, current, load]);

  const doOverwrite = useCallback(
    (t: QueueTemplate) => {
      Alert.alert(
        'Update template',
        `Replace “${t.name}” with the current lineup (${current.length} athlete${
          current.length === 1 ? '' : 's'
        })?`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Update',
            onPress: async () => {
              await updateTemplate(t.id, { athleteIds: current });
              await load();
            },
          },
        ],
      );
    },
    [current, load],
  );

  const doDelete = useCallback(
    (t: QueueTemplate) => {
      // Templates are documents, not people: deleting one touches no runs and no
      // athletes, which is why this is a delete and the roster only ever archives.
      Alert.alert('Delete template', `Delete “${t.name}”? Athletes and runs are not affected.`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await deleteTemplate(t.id);
            await load();
          },
        },
      ]);
    },
    [load],
  );

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet">
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={styles.container}>
          <View style={styles.header}>
            <Text style={styles.title}>Lineup templates</Text>
            <Pressable onPress={onClose} hitSlop={10} style={({ pressed }) => pressed && styles.dim}>
              <Text style={styles.done}>Done</Text>
            </Pressable>
          </View>

          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            <Text style={styles.sectionLabel}>SAVE TODAY’S LINEUP</Text>
            <View style={styles.saveRow}>
              <TextInput
                style={styles.input}
                value={newName}
                onChangeText={setNewName}
                placeholder={current.length ? 'e.g. Sprint group' : 'Add athletes to the lineup first'}
                placeholderTextColor="#475569"
                editable={current.length > 0}
                returnKeyType="done"
                onSubmitEditing={doSaveNew}
              />
              <Pressable
                onPress={doSaveNew}
                disabled={!newName.trim() || !current.length}
                style={({ pressed }) => [
                  styles.saveBtn,
                  (!newName.trim() || !current.length || pressed) && styles.dim,
                ]}
              >
                <Text style={styles.saveBtnText}>Save</Text>
              </Pressable>
            </View>
            <Text style={styles.hint}>
              {current.length
                ? `${current.length} athlete${current.length === 1 ? '' : 's'} in today’s lineup`
                : 'No lineup yet — add athletes from the roster.'}
            </Text>

            <Text style={[styles.sectionLabel, { marginTop: 26 }]}>TEMPLATES</Text>
            {templates.length === 0 ? (
              <Text style={styles.empty}>
                No templates yet. Save a lineup above and it will be one tap to load next time.
              </Text>
            ) : (
              templates.map((t) => (
                <View key={t.id} style={styles.row}>
                  <Pressable style={styles.rowMain} onPress={() => doLoad(t)}>
                    <Text style={styles.rowName} numberOfLines={1}>
                      {t.name}
                    </Text>
                    <Text style={styles.rowSub}>
                      {t.athleteIds.length} athlete{t.athleteIds.length === 1 ? '' : 's'} · replaces
                      today’s lineup
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => doOverwrite(t)}
                    hitSlop={6}
                    disabled={!current.length}
                    style={({ pressed }) => [
                      styles.smallBtn,
                      (!current.length || pressed) && styles.dim,
                    ]}
                  >
                    <Text style={styles.smallBtnText}>Update</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => doDelete(t)}
                    hitSlop={6}
                    style={({ pressed }) => [styles.smallBtn, pressed && styles.dim]}
                  >
                    <Text style={styles.deleteText}>Delete</Text>
                  </Pressable>
                </View>
              ))
            )}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, backgroundColor: '#0e1116' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#243042',
  },
  title: { color: '#fff', fontSize: 19, fontWeight: '800' },
  done: { color: '#60a5fa', fontSize: 15, fontWeight: '800' },
  body: { padding: 16, paddingBottom: 40 },
  sectionLabel: { color: '#64748b', fontSize: 10, fontWeight: '800', letterSpacing: 0.8, marginBottom: 8 },
  saveRow: { flexDirection: 'row', gap: 10 },
  input: {
    flex: 1,
    backgroundColor: '#0b0e13',
    color: '#fff',
    fontSize: 15,
    borderRadius: 10,
    paddingVertical: 11,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: '#243042',
  },
  saveBtn: {
    backgroundColor: '#1d4ed8',
    borderRadius: 10,
    paddingHorizontal: 18,
    justifyContent: 'center',
  },
  saveBtnText: { color: '#fff', fontWeight: '800', fontSize: 14 },
  hint: { color: '#64748b', fontSize: 11, marginTop: 8 },
  empty: { color: '#64748b', fontSize: 13, lineHeight: 19 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#161b22',
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#243042',
  },
  rowMain: { flex: 1, minWidth: 0 },
  rowName: { color: '#e2e8f0', fontSize: 15, fontWeight: '700' },
  rowSub: { color: '#64748b', fontSize: 11, marginTop: 3 },
  smallBtn: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#243042',
  },
  smallBtnText: { color: '#94a3b8', fontSize: 12, fontWeight: '700' },
  deleteText: { color: '#f87171', fontSize: 12, fontWeight: '700' },
  dim: { opacity: 0.45 },
});
