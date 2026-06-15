// Settings: latency calibration (set/adjust the Mode 2 beep-latency offset and
// see its effect). About + Donate are added in a later task.

import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { useSettings } from '../settings/SettingsProvider';
import { DEFAULT_REACTION_OFFSET_MS } from '../db/database';

const SAMPLE_RAW_MS = 350; // illustrative raw reaction for the live preview

export default function SettingsScreen() {
  const { reactionOffsetMs, measuredAudioLatencyMs, setReactionOffsetMs } = useSettings();
  const [draft, setDraft] = useState(String(reactionOffsetMs));

  useEffect(() => {
    setDraft(String(reactionOffsetMs));
  }, [reactionOffsetMs]);

  const commit = (t: string) => {
    setDraft(t);
    const n = parseInt(t, 10);
    if (Number.isFinite(n)) setReactionOffsetMs(n);
  };
  const bump = (d: number) => setReactionOffsetMs(reactionOffsetMs + d);

  const previewMs = Math.max(0, SAMPLE_RAW_MS - reactionOffsetMs);

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 32 }}>
      <Text style={styles.title}>Settings</Text>

      <Section title="Reaction latency calibration">
        <Text style={styles.help}>
          The GO beep plays on the phone, slightly after the gate's real GO, so Mode 2 reaction
          times read high. This offset is subtracted from the displayed/saved reaction. Raw gate
          values are always kept.
        </Text>

        <View style={styles.offsetRow}>
          <Stepper label="−25" onPress={() => bump(-25)} />
          <Stepper label="−5" onPress={() => bump(-5)} />
          <TextInput
            style={styles.input}
            value={draft}
            onChangeText={commit}
            keyboardType="number-pad"
            returnKeyType="done"
            selectTextOnFocus
          />
          <Text style={styles.unit}>ms</Text>
          <Stepper label="+5" onPress={() => bump(5)} />
          <Stepper label="+25" onPress={() => bump(25)} />
        </View>

        <View style={styles.previewBox}>
          <Text style={styles.previewLabel}>Effect on a {(SAMPLE_RAW_MS / 1000).toFixed(3)}s raw reaction</Text>
          <Text style={styles.previewVal}>
            {(SAMPLE_RAW_MS / 1000).toFixed(3)}s − {reactionOffsetMs}ms = {(previewMs / 1000).toFixed(3)}s
          </Text>
        </View>

        <View style={styles.measuredRow}>
          <Text style={styles.measuredText}>
            {measuredAudioLatencyMs != null
              ? `Measured audio-pipeline latency: ${measuredAudioLatencyMs} ms`
              : 'Audio latency not measured yet — run a Mode 2 start.'}
          </Text>
          {measuredAudioLatencyMs != null ? (
            <Pressable onPress={() => setReactionOffsetMs(measuredAudioLatencyMs)} hitSlop={6}>
              <Text style={styles.link}>Use measured</Text>
            </Pressable>
          ) : null}
        </View>
        <Text style={styles.note}>
          Note: the measured value is only the audio-pipeline part. Total beep latency also
          includes BLE delivery, so the offset is usually a bit higher than the measured value.
        </Text>

        <Pressable onPress={() => setReactionOffsetMs(DEFAULT_REACTION_OFFSET_MS)} hitSlop={6}>
          <Text style={[styles.link, { marginTop: 12 }]}>Reset to default ({DEFAULT_REACTION_OFFSET_MS} ms)</Text>
        </Pressable>
      </Section>
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Stepper({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.stepper, pressed && styles.dim]}
      hitSlop={4}
    >
      <Text style={styles.stepperText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0e1116', paddingTop: 56, paddingHorizontal: 16 },
  title: { color: '#fff', fontSize: 22, fontWeight: '800', marginBottom: 12 },
  section: { backgroundColor: '#161b22', borderRadius: 14, padding: 16, marginBottom: 14 },
  sectionTitle: { color: '#e2e8f0', fontSize: 16, fontWeight: '700', marginBottom: 8 },
  help: { color: '#94a3b8', fontSize: 13, lineHeight: 18, marginBottom: 12 },
  offsetRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: {
    flex: 1,
    backgroundColor: '#0b0e13',
    color: '#fff',
    fontSize: 20,
    fontWeight: '800',
    textAlign: 'center',
    borderRadius: 10,
    paddingVertical: 10,
    fontVariant: ['tabular-nums'],
  },
  unit: { color: '#64748b', fontSize: 14 },
  stepper: { backgroundColor: '#243042', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 10 },
  stepperText: { color: '#cbd5e1', fontWeight: '700', fontVariant: ['tabular-nums'] },
  previewBox: { backgroundColor: '#0b0e13', borderRadius: 10, padding: 12, marginTop: 12 },
  previewLabel: { color: '#64748b', fontSize: 12 },
  previewVal: { color: '#34d399', fontSize: 16, fontWeight: '700', marginTop: 4, fontVariant: ['tabular-nums'] },
  measuredRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 14,
    gap: 10,
  },
  measuredText: { color: '#94a3b8', fontSize: 13, flex: 1 },
  link: { color: '#60a5fa', fontWeight: '700', fontSize: 13 },
  note: { color: '#64748b', fontSize: 11, lineHeight: 16, marginTop: 8 },
  dim: { opacity: 0.5 },
});
