// Settings. One coach-facing switch (runs started at the gate), Donate, About,
// and — once unlocked from the version row — Developer mode with the way into
// Diagnostics.
//
// Gone from here, 2026-09: the reaction-latency calibration, the reaction-
// correction mode with its clock-sync readout, the measured-latency statistics,
// and the "Timing engine" toggle. Every one of them tuned or selected the v1
// Timer, which the firmware stopped speaking to in July and which is deleted.
// Reaction mode returns with the gate buzzer at the PCB respin and will want its
// own calibration; docs/LATENCY.md is the record of this one.

import { useState } from 'react';
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import Constants from 'expo-constants';

import { useSettings } from '../settings/SettingsProvider';
import { NoteWithMore } from '../components/InfoSheet';
import { COLUMN_MAX_WIDTH, topPad, useLayout } from '../layout';
import { INTERACTIVE } from '../theme';

const DONATE_URL = 'https://www.zeffy.com/en-US/donation-form/donate-to-equalsplit';

const APP_VERSION = Constants.expoConfig?.version ?? '1.0.0';

/**
 * Taps on the version row that reveal Developer mode.
 *
 * It used to be the FIRST thing on this screen: a labelled switch reading "Show
 * advanced / diagnostic info", which anyone opening Settings saw before anything
 * else. Turning it on replaces clean results with raw values and confidence figures
 * that read as noise to a coach, and it opens Diagnostics — a screen that is exactly
 * right for a meet and exactly wrong for a first impression of the app.
 *
 * Behind a tap count it stays one gesture away for someone who knows, and out of
 * reach of someone who does not. Seven is the convention, and conventions are worth
 * following for a gesture nobody can be told about.
 */
const DEV_UNLOCK_TAPS = 7;

export default function SettingsScreen({
  onOpenDebug,
  onBack,
}: {
  onOpenDebug?: () => void;
  /** Close Settings. Absent when it is not presented over anything. */
  onBack?: () => void;
}) {
  const { devMode, setDevMode, logStandalone, setLogStandalone } = useSettings();
  const { insets, wide } = useLayout();
  // Reset whenever Settings is left: the tab unmounts this screen, so a half-finished
  // tap count cannot survive to surprise someone later.
  const [versionTaps, setVersionTaps] = useState(0);
  // Already on stays visible, or there would be no way to turn it off again.
  const devVisible = devMode || versionTaps >= DEV_UNLOCK_TAPS;

  return (
    // WIDE: a centred column. Nothing on this screen benefits from width, and a
    // 1000pt switch row is the phone layout stretched.
    <ScrollView
      style={[styles.container, { paddingTop: topPad(insets) }]}
      contentContainerStyle={[styles.body, wide && styles.bodyWide]}
    >
      {onBack ? (
        <Pressable onPress={onBack} hitSlop={10} style={styles.backRow}>
          <Text style={styles.backText}>‹  Roster</Text>
        </Pressable>
      ) : null}
      <Text style={styles.title}>Settings</Text>

      {/* THE ONE SETTING A COACH SEES, so it speaks their language. "B1", "Mode-1",
          "reconstructed from the event stream" and "app-armed" are all ours. The
          full account — including the B1/B2 caveat, which is the reason to leave it
          off — is in the sheet, unchanged in substance. */}
      <Section title="Runs started at the gate">
        <View style={styles.devRow}>
          <Text style={styles.devLabel}>Save runs started with the gate&apos;s button</Text>
          <Switch
            value={logStandalone}
            onValueChange={setLogStandalone}
            trackColor={{ false: '#243042', true: '#1d4ed8' }}
            thumbColor="#e2e8f0"
          />
        </View>
        <View style={styles.noteRow}>
          <NoteWithMore
            note="A run started by pressing the button on the gate is saved to History while the phone is connected. Leave off unless you use it."
            title="Runs started at the gate"
            body={[
              'When this is on, a run you start on the gate itself — by pressing its button rather than tapping Arm in the app — is rebuilt from the gate’s own events and saved to History, as long as the phone is connected at the time. Runs armed from the app are never affected.',
              'Leave it off unless you use the gate’s button. The gate cannot tell the app which of its two buttons started a run, so a reaction-start run begun at the gate would be saved as its gate-to-gate leg only.',
            ]}
          />
        </View>
      </Section>

      {/* ABOVE THE FOLD, and the unlock note in About says so. This section once
          sat after About — where it is unlocked — and turning dev mode ON used to
          insert four calibration sections above it, so the switch that turns it off
          ended up below everything it had just revealed ("I can't find how to turn
          it off"). Those sections are gone with the v1 Timer they tuned; the
          placement stays, because the note under the version row points here. */}
      {devVisible ? (
        <Section title="Developer mode">
          <View style={styles.devRow}>
            <Text style={styles.devLabel}>Show advanced / diagnostic info</Text>
            <Switch
              value={devMode}
              onValueChange={setDevMode}
              trackColor={{ false: '#243042', true: '#1d4ed8' }}
              thumbColor="#e2e8f0"
            />
          </View>
          <Text style={styles.note}>
            Off shows clean results only. On reveals raw traces and accuracy detail on the timing
            screens, and Diagnostics below. Times are always measured and saved either way.
          </Text>
          {devMode && onOpenDebug ? (
            <Pressable
              onPress={onOpenDebug}
              style={({ pressed }) => [styles.debugBtn, pressed && styles.dim]}
            >
              <Text style={styles.debugBtnText}>Diagnostics &amp; v2 Lab  ›</Text>
            </Pressable>
          ) : null}
        </Section>
      ) : null}

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
        {/* The version row is also the way in to Developer mode. It carries no hint of
            that, which is the point — see DEV_UNLOCK_TAPS. The BLE protocol number
            that used to sit beneath it is gone: a coach will never act on it, and
            Diagnostics already reports it beside the gate's own. */}
        <Row label="App version" value={APP_VERSION} onPress={() => setVersionTaps((n) => n + 1)} />
        {/* THE GESTURE NEEDS AN ANSWER. The switch it reveals is at the TOP of this
            screen — it has to be, or turning dev mode off means scrolling past the
            four sections turning it on just added — so without a word here the taps
            appear to do nothing at all. */}
        {versionTaps >= DEV_UNLOCK_TAPS ? (
          <Text style={styles.unlockNote}>Developer mode is at the top of Settings.</Text>
        ) : null}
        <Text style={styles.aboutBlurb}>
          EqualSplit pairs your phone with the start gate over Bluetooth. The gate keeps the
          authoritative time and hears the finish gate over a direct gate-to-gate radio link, so the
          phone is never in the timing path. Times are stored locally on your device.
        </Text>
      </Section>

    </ScrollView>
  );
}

function Row({
  label,
  value,
  onPress,
}: {
  label: string;
  value: string;
  onPress?: () => void;
}) {
  // No pressed style and no hit feedback when it is the unlock row: a row that
  // visibly responds to a tap invites a second one, which is the opposite of what
  // this is for.
  const body = (
    <View style={styles.aboutRow}>
      <Text style={styles.aboutLabel}>{label}</Text>
      <Text style={styles.aboutValue}>{value}</Text>
    </View>
  );
  return onPress ? <Pressable onPress={onPress}>{body}</Pressable> : body;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0e1116', paddingHorizontal: 16 },
  body: { paddingBottom: 32 },
  bodyWide: { width: '100%', maxWidth: COLUMN_MAX_WIDTH, alignSelf: 'center' },
  backRow: { marginBottom: 6 },
  backText: { color: INTERACTIVE, fontSize: 15, fontWeight: '700' },
  title: { color: '#fff', fontSize: 22, fontWeight: '800', marginBottom: 12 },
  section: { backgroundColor: '#161b22', borderRadius: 14, padding: 16, marginBottom: 14 },
  sectionTitle: { color: '#e2e8f0', fontSize: 16, fontWeight: '700', marginBottom: 8 },
  devRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  devLabel: { color: '#cbd5e1', fontSize: 14, flex: 1 },
  help: { color: '#94a3b8', fontSize: 13, lineHeight: 18, marginBottom: 12 },
  debugBtn: {
    marginTop: 12,
    backgroundColor: '#0b0e13',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: '#243042',
  },
  debugBtnText: { color: INTERACTIVE, fontWeight: '700', fontSize: 14 },
  note: { color: '#64748b', fontSize: 11, lineHeight: 16, marginTop: 8 },
  noteRow: { marginTop: 4 },
  dim: { opacity: 0.5 },
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
  unlockNote: { color: INTERACTIVE, fontSize: 13, fontWeight: '700', marginTop: 10 },
  aboutBlurb: { color: '#64748b', fontSize: 12, lineHeight: 18, marginTop: 12 },
});

