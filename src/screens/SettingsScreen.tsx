// Settings: latency calibration (set/adjust the Mode 2 beep-latency offset and
// see its effect). About + Donate are added in a later task.

import { useEffect, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import Constants from 'expo-constants';

import { useSettings, type LatencySample } from '../settings/SettingsProvider';
import { useGate } from '../ble/GateProvider';
import { DEFAULT_REACTION_OFFSET_MS } from '../db/database';
import { PROTO_VERSION } from '../ble/constants';

const SAMPLE_RAW_MS = 350; // illustrative raw reaction for the live preview

// TODO: replace with the real donation link before release.
const DONATE_URL = 'https://example.com/donate';

const APP_VERSION = Constants.expoConfig?.version ?? '1.0.0';

type Stats = { n: number; mean: number; sd: number; min: number; max: number };
function stats(values: number[]): Stats | null {
  if (values.length === 0) return null;
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return { n, mean, sd: Math.sqrt(variance), min: Math.min(...values), max: Math.max(...values) };
}
const pick = (s: LatencySample[], key: 'beepLatency' | 'bleOneway' | 'audioGap'): number[] =>
  s.map((x) => x[key]).filter((v): v is number => v != null);

export default function SettingsScreen() {
  const {
    reactionOffsetMs,
    measuredAudioLatencyMs,
    setReactionOffsetMs,
    correctionMode,
    setCorrectionMode,
    latencySamples,
  } = useSettings();
  const gate = useGate();
  const connected = gate.status === 'connected';
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

      <Section title="Reaction correction">
        <View style={styles.toggleRow}>
          <Toggle
            label="Synced (per-run)"
            active={correctionMode === 'synced'}
            onPress={() => setCorrectionMode('synced')}
          />
          <Toggle
            label="Fixed offset"
            active={correctionMode === 'fixed'}
            onPress={() => setCorrectionMode('fixed')}
          />
        </View>
        <Text style={styles.help}>
          Synced computes each run&apos;s exact beep latency from clock sync (cancels run-to-run
          jitter) and falls back to the fixed offset when no clock anchor is available.
        </Text>
        <View style={styles.measuredRow}>
          <Text style={styles.measuredText}>
            {gate.clockSync
              ? `Synced · RTT ${Math.round(gate.clockSync.minRttMs)}/${Math.round(
                  gate.clockSync.medianRttMs,
                )}/${Math.round(gate.clockSync.maxRttMs)} ms (min/med/max) · offset jitter ±${Math.round(
                  gate.clockSync.offsetSpreadMs,
                )} ms · clock-sync bound ±${Math.round(gate.clockSync.minRttMs / 2)} ms`
              : gate.syncing
                ? 'Syncing clock…'
                : connected
                  ? 'Clock sync unavailable — using fixed offset.'
                  : 'Connect to sync the clock.'}
          </Text>
          <Pressable onPress={() => gate.syncClock()} hitSlop={6} disabled={!connected}>
            <Text style={[styles.link, !connected && styles.dim]}>Re-sync</Text>
          </Pressable>
        </View>
        <Text style={styles.note}>
          RTT is the closest observable proxy for the iOS connection interval (iOS doesn&apos;t
          expose the negotiated value). Lower and tighter RTT ⇒ better sync; residual sync error
          ≈ RTT/2.
        </Text>
      </Section>

      <Section title={`Measured latency (last ${latencySamples.length} runs)`}>
        <StatBlock label="Beep latency" values={pick(latencySamples, 'beepLatency')} />
        <StatBlock label="BLE one-way" values={pick(latencySamples, 'bleOneway')} />
        <StatBlock label="Audio gap" values={pick(latencySamples, 'audioGap')} />
        <Text style={styles.note}>
          Stdev is the run-to-run jitter. Fixed leaves the full beep-latency stdev in your reaction
          times; synced subtracts each run&apos;s measured latency, so the residual is ≈ sync error
          (RTT/2) + audio-gap quantization (~16 ms). Lower stdev = more trustworthy.
        </Text>
      </Section>

      <Section title="Support EqualSplit">
        <Text style={styles.help}>
          EqualSplit is a low-cost, open sprint-timing system. If it's useful to you, a small
          donation helps keep it going.
        </Text>
        <Pressable
          onPress={() => Linking.openURL(DONATE_URL).catch(() => {})}
          style={({ pressed }) => [styles.donate, pressed && styles.dim]}
        >
          <Text style={styles.donateText}>♥  Donate</Text>
        </Pressable>
      </Section>

      <Section title="About">
        <Row label="App version" value={APP_VERSION} />
        <Row label="BLE protocol" value={`v${PROTO_VERSION}`} />
        <Text style={styles.aboutBlurb}>
          EqualSplit pairs your phone with the start gate over Bluetooth; the gate keeps the
          authoritative time and relays the finish gate's result over ESP-NOW. Times are stored
          locally on your device.
        </Text>
      </Section>
    </ScrollView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.aboutRow}>
      <Text style={styles.aboutLabel}>{label}</Text>
      <Text style={styles.aboutValue}>{value}</Text>
    </View>
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

function Toggle({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.toggle, active && styles.toggleActive]}>
      <Text style={[styles.toggleText, active && styles.toggleTextActive]}>{label}</Text>
    </Pressable>
  );
}

function StatBlock({ label, values }: { label: string; values: number[] }) {
  const s = stats(values);
  return (
    <View style={styles.statBlock}>
      <Text style={styles.statBlockLabel}>{label}</Text>
      {s ? (
        <Text style={styles.statBlockVal}>
          mean {s.mean.toFixed(0)} · sd {s.sd.toFixed(0)} · {s.min.toFixed(0)}–{s.max.toFixed(0)} ms
          · n={s.n}
        </Text>
      ) : (
        <Text style={styles.statBlockNone}>no data</Text>
      )}
    </View>
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
  toggleRow: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  toggle: {
    flex: 1,
    backgroundColor: '#0b0e13',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#243042',
  },
  toggleActive: { backgroundColor: '#1d4ed8', borderColor: '#3b82f6' },
  toggleText: { color: '#94a3b8', fontWeight: '700' },
  toggleTextActive: { color: '#fff' },
  statBlock: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1f2733',
  },
  statBlockLabel: { color: '#cbd5e1', fontSize: 13 },
  statBlockVal: {
    color: '#9fe6a0',
    fontSize: 12,
    fontFamily: undefined,
    fontVariant: ['tabular-nums'],
  },
  statBlockNone: { color: '#475569', fontSize: 12 },
  donate: { backgroundColor: '#db2777', borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  donateText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  aboutRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1f2733',
  },
  aboutLabel: { color: '#94a3b8', fontSize: 14 },
  aboutValue: { color: '#e2e8f0', fontSize: 14, fontWeight: '600' },
  aboutBlurb: { color: '#64748b', fontSize: 12, lineHeight: 18, marginTop: 12 },
});

