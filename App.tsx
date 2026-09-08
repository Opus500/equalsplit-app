// Root: BLE provider + a lightweight tab switcher. Timer stays mounted (keeps
// its BLE subscription, audio, and any in-progress run alive); History and Debug
// mount on demand so they show fresh data each time.

import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';

import { GateProvider } from './src/ble/GateProvider';
import { V2Provider } from './src/ble/V2Provider';
import { SettingsProvider, useSettings } from './src/settings/SettingsProvider';
import { RosterProvider } from './src/roster/RosterProvider';
import { PendingRunProvider } from './src/runs/PendingRunProvider';
import { initDb } from './src/db/database';
import { installCrashLog, logEvent } from './src/diag/crashlog';
import TimerScreen from './src/screens/TimerScreen';
import TimerV2Screen from './src/screens/TimerV2Screen';
import DrillsTab from './src/screens/DrillsTab';
import RosterScreen from './src/screens/RosterScreen';
import HistoryScreen from './src/screens/HistoryScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import DebugScreen from './src/screens/DebugScreen';
import VideoTab from './src/screens/VideoTab';

type Tab = 'timer' | 'drills' | 'roster' | 'video';

/**
 * The screens that are NOT tabs, as one stack rather than three special cases.
 *
 * History and Settings both left the tab bar: six tabs is two past what fits, and
 * neither is something a coach reaches for mid-rep. They are reached from the same
 * corner of the same screen — Roster's header — because Timer, Drills and Video are
 * what a coach DOES and Roster is what they manage. One pattern, not two.
 *
 * Diagnostics stays a child of Settings and is in the same stack rather than nested
 * inside it, so there is exactly one place that knows what is on top and what
 * closing it goes back to. That is what makes the dev-mode fallback a single line.
 */
type Overlay = 'history' | 'settings' | 'debug' | null;

export default function App() {
  // BEFORE anything else can fail. Installed in the module body rather than an
  // effect: an error thrown while the tree is first mounting happens before any
  // effect runs, and that is exactly the error nobody can otherwise see.
  installCrashLog();

  useEffect(() => {
    initDb().catch((e) => logEvent('DB', `initDb failed: ${String(e)}`));
  }, []);

  return (
    <SettingsProvider>
      <RosterProvider>
        <GateProvider>
          <V2Provider>
            {/* Inside both BLE providers (it settles the discard window when the
                gates drop) and inside RosterProvider (a discard puts the athlete
                back up). */}
            <PendingRunProvider>
              <AppShell />
            </PendingRunProvider>
          </V2Provider>
        </GateProvider>
      </RosterProvider>
    </SettingsProvider>
  );
}

// Inside the providers so it can read devMode (gates the Debug tab). Default OFF.
function AppShell() {
  const { devMode, useV2Engine } = useSettings();
  const [tab, setTab] = useState<Tab>('timer');
  const [overlay, setOverlay] = useState<Overlay>(null);

  // If dev mode is turned off while in Diagnostics, fall back to where it's reached
  // from — which is now the Settings overlay rather than a tab.
  useEffect(() => {
    if (!devMode && overlay === 'debug') setOverlay('settings');
  }, [devMode, overlay]);

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <View style={styles.screens}>
        <View style={[styles.fill, tab !== 'timer' && styles.hidden]}>
          {useV2Engine ? <TimerV2Screen /> : <TimerScreen />}
        </View>
        {/* Kept mounted (hidden), like Timer: preserves an in-progress drill run
            or rep set, the selected drill, and — critically — the per-run save
            guard across tab switches, so a completed run can't be re-saved on
            remount. DrillsTab holds both engines behind a segmented switch. */}
        <View style={[styles.fill, tab !== 'drills' && styles.hidden]}>
          <DrillsTab />
        </View>
        {tab === 'roster' && (
          <View style={styles.fill}>
            <RosterScreen
              onOpenHistory={() => setOverlay('history')}
              onOpenSettings={() => setOverlay('settings')}
              openHistoryFlag={overlay === 'history'}
            />
          </View>
        )}
        {/* Mounts on demand, and is UNMOUNTED on leaving: it holds a video player
            and a decoded filmstrip, neither of which should outlive the screen.
            The cost is real and known — leaving the Video tab discards an imported
            clip and both its marks, exactly the loss that made VideoTab keep Mark
            mounted behind the library pane. The two are not in conflict: a glance
            at Videos is a move within the feature, while leaving for Timer or
            Roster is not, and a decoder held open across an entire practice is a
            worse trade than re-importing a clip. Revisit if that proves wrong on
            a real session — the fix is the isVisible prop VideoTab already
            threads. */}
        {tab === 'video' && (
          <View style={styles.fill}>
            <VideoTab />
          </View>
        )}
      </View>

      <View style={styles.tabBar}>
        <TabButton label="Timer" active={tab === 'timer'} onPress={() => setTab('timer')} />
        {/* MODES, not Drills. "Drill" already meant something else on the Timer — a
            LABEL you attach to an ordinary run, from a trimmed list that deliberately
            never offers L Drill or Shuttle. What lives here are ways of timing that
            the app drives and counts for you, and calling both "drill" made the two
            indistinguishable in conversation.

            Not "preset modes", which was the first instinct: preset only means
            something against a custom alternative, and there is none — it would
            promise configurability the app does not have. The tab id and the screens
            stay `drills`, because that is what they genuinely render; it is the
            category that needed the name. */}
        <TabButton label="Modes" active={tab === 'drills'} onPress={() => setTab('drills')} />
        <TabButton label="Roster" active={tab === 'roster'} onPress={() => setTab('roster')} />
        <TabButton label="Video" active={tab === 'video'} onPress={() => setTab('video')} />
      </View>

      {/* ABOVE THE TAB BAR, not beside it. These are not places you switch between,
          they are things you open and close — and a tab bar underneath an open
          History would offer a way out that leaves the overlay behind it. */}
      {overlay === 'history' && (
        <View style={styles.overlay}>
          {/* isActive is what makes History reload its sessions. It used to mean "is
              the selected tab"; it means "is open" now, which is the same claim. */}
          <HistoryScreen isActive onBack={() => setOverlay(null)} />
        </View>
      )}
      {overlay === 'settings' && (
        <View style={styles.overlay}>
          <SettingsScreen
            onBack={() => setOverlay(null)}
            onOpenDebug={devMode ? () => setOverlay('debug') : undefined}
          />
        </View>
      )}
      {overlay === 'debug' && devMode && (
        <View style={styles.overlay}>
          <DebugScreen onBack={() => setOverlay('settings')} />
        </View>
      )}
    </View>
  );
}

function TabButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.tab} onPress={onPress}>
      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0e1116' },
  screens: { flex: 1 },
  fill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  // Covers the tab bar too, which is the difference between an overlay and a tab.
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#0e1116',
  },
  hidden: { display: 'none' },
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#1f2733',
    backgroundColor: '#0b0e13',
    paddingBottom: 24,
    // THE BAR'S TOP PADDING MOVED INTO THE TAB. It was 8pt of dead space above a
    // 30pt target; as padding on the tab it is 8pt of target instead, so most of
    // the growth needed to reach a comfortable size costs no height at all.
    paddingTop: 0,
  },
  // 48pt, not Apple's 44pt floor. This is the most-pressed control in the app and
  // it is pressed one-handed, outdoors, sometimes with a glove. The bar goes from
  // 62pt to 72pt; both dense screens absorb it in a flexing area — the Timer's
  // stage is flex:1 and the marking screen's preview takes the leftover space
  // above a controls pane that was already capped and scrolling.
  tab: { flex: 1, alignItems: 'center', paddingVertical: 15 },
  tabText: { color: '#64748b', fontSize: 13, fontWeight: '600' },
  tabTextActive: { color: '#60a5fa' },
});
