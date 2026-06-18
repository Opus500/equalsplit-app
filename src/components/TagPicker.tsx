// Shared, compact athlete + drill tagging UI. Used both on the Timer (set the
// persistent current tags before a run) and in History (edit a saved run's tags).
// Drill is a single short curated preset list (mode-agnostic) shown as pills, not
// a bulky dropdown; "Other…" reveals a custom text field.

import { useEffect, useState } from 'react';
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

export const DRILL_PRESETS = [
  '10m',
  '20m',
  '30m',
  '40yd dash',
  'L-drill (3-cone)',
  'block start',
  'get-up',
];

const OTHER = 'Other…';

/** "Jayden · 30m" — joins the non-empty tags; '' if both empty. */
export function formatTags(name?: string | null, drill?: string | null): string {
  return [name, drill]
    .map((s) => (s ?? '').trim())
    .filter(Boolean)
    .join(' · ');
}

function Chip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.chip, active && styles.chipActive, pressed && styles.dim]}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

export function TagPickerModal({
  visible,
  title = 'Run tags',
  initialName,
  initialDrill,
  recents,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  title?: string;
  initialName: string;
  initialDrill: string;
  recents: string[];
  onClose: () => void;
  onSubmit: (name: string, drill: string) => void;
}) {
  const [name, setName] = useState(initialName);
  const [drill, setDrill] = useState(initialDrill);
  const [otherText, setOtherText] = useState('');
  const [otherActive, setOtherActive] = useState(false);

  // Re-seed whenever the modal opens (it may target a different run each time).
  useEffect(() => {
    if (!visible) return;
    setName(initialName);
    const isPreset = DRILL_PRESETS.includes(initialDrill);
    setDrill(initialDrill);
    setOtherActive(!isPreset && !!initialDrill);
    setOtherText(isPreset ? '' : initialDrill);
  }, [visible, initialName, initialDrill]);

  const pickPreset = (p: string) => {
    setOtherActive(false);
    setDrill((cur) => (cur === p ? '' : p)); // tap again to deselect
  };
  const pickOther = () => {
    setOtherActive(true);
    setDrill(otherText.trim());
  };
  const onOtherText = (t: string) => {
    setOtherText(t);
    setDrill(t);
  };

  const submit = () => {
    onSubmit(name.trim(), (otherActive ? otherText : drill).trim());
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <Pressable style={styles.backdrop} onPress={onClose}>
          <Pressable style={styles.card} onPress={() => {}}>
            <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
              <Text style={styles.cardTitle}>{title}</Text>

              <View style={styles.labelRow}>
            <Text style={styles.label}>Athlete</Text>
            {name ? (
              <Pressable onPress={() => setName('')} hitSlop={8}>
                <Text style={styles.clear}>Clear</Text>
              </Pressable>
            ) : null}
          </View>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="optional — leave empty for solo"
            placeholderTextColor="#475569"
            autoCapitalize="words"
            returnKeyType="done"
          />
          {recents.length ? (
            <View style={styles.chipWrap}>
              {recents.map((r) => (
                <Chip key={r} label={r} active={name.trim() === r} onPress={() => setName(r)} />
              ))}
            </View>
          ) : null}

          <Text style={[styles.label, { marginTop: 16 }]}>Drill</Text>
          <View style={styles.chipWrap}>
            {DRILL_PRESETS.map((p) => (
              <Chip key={p} label={p} active={!otherActive && drill === p} onPress={() => pickPreset(p)} />
            ))}
            <Chip label={OTHER} active={otherActive} onPress={pickOther} />
          </View>
          {otherActive ? (
            <TextInput
              style={[styles.input, { marginTop: 8 }]}
              value={otherText}
              onChangeText={onOtherText}
              placeholder="custom drill label"
              placeholderTextColor="#475569"
              autoCapitalize="none"
              returnKeyType="done"
            />
          ) : null}

              <View style={styles.actions}>
                <Pressable
                  onPress={onClose}
                  style={({ pressed }) => [styles.btn, pressed && styles.dim]}
                >
                  <Text style={styles.btnText}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={submit}
                  style={({ pressed }) => [styles.btn, styles.btnPrimary, pressed && styles.dim]}
                >
                  <Text style={[styles.btnText, styles.btnPrimaryText]}>Done</Text>
                </Pressable>
              </View>
            </ScrollView>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
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
  card: { backgroundColor: '#161b22', borderRadius: 16, padding: 18, maxHeight: '88%' },
  cardTitle: { color: '#fff', fontSize: 17, fontWeight: '800', marginBottom: 12 },
  labelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label: { color: '#94a3b8', fontSize: 13, fontWeight: '700', marginBottom: 6 },
  clear: { color: '#60a5fa', fontSize: 13, fontWeight: '700' },
  input: {
    backgroundColor: '#0b0e13',
    color: '#fff',
    fontSize: 16,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  chip: {
    backgroundColor: '#0b0e13',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: '#243042',
  },
  chipActive: { backgroundColor: '#1d4ed8', borderColor: '#3b82f6' },
  chipText: { color: '#cbd5e1', fontSize: 13, fontWeight: '600' },
  chipTextActive: { color: '#fff' },
  actions: { flexDirection: 'row', gap: 10, marginTop: 18 },
  btn: { flex: 1, backgroundColor: '#243042', borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  btnText: { color: '#cbd5e1', fontWeight: '700' },
  btnPrimary: { backgroundColor: '#2563eb' },
  btnPrimaryText: { color: '#fff' },
  dim: { opacity: 0.5 },
});
