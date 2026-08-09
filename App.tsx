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
import TimerScreen from './src/screens/TimerScreen';
import TimerV2Screen from './src/screens/TimerV2Screen';
import DrillsTab from './src/screens/DrillsTab';
import RosterScreen from './src/screens/RosterScreen';
import HistoryScreen from './src/screens/HistoryScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import DebugScreen from './src/screens/DebugScreen';

type Tab = 'timer' | 'drills' | 'roster' | 'history' | 'settings' | 'debug';

export default function App() {
  useEffect(() => {
    initDb().catch(() => {});
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

  // If dev mode is turned off while on Debug, fall back to where it's reached from.
  useEffect(() => {
    if (!devMode && tab === 'debug') setTab('settings');
  }, [devMode, tab]);

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
            <RosterScreen />
          </View>
        )}
        {tab === 'history' && (
          <View style={styles.fill}>
            <HistoryScreen isActive={tab === 'history'} />
          </View>
        )}
        {tab === 'settings' && (
          <View style={styles.fill}>
            <SettingsScreen onOpenDebug={devMode ? () => setTab('debug') : undefined} />
          </View>
        )}
        {/* Debug is a dev tool, not a primary object — reached THROUGH Settings
            rather than owning a permanent tab slot. */}
        {tab === 'debug' && devMode && (
          <View style={styles.fill}>
            <DebugScreen onBack={() => setTab('settings')} />
          </View>
        )}
      </View>

      <View style={styles.tabBar}>
        <TabButton label="Timer" active={tab === 'timer'} onPress={() => setTab('timer')} />
        <TabButton label="Drills" active={tab === 'drills'} onPress={() => setTab('drills')} />
        <TabButton label="Roster" active={tab === 'roster'} onPress={() => setTab('roster')} />
        <TabButton label="History" active={tab === 'history'} onPress={() => setTab('history')} />
        <TabButton
          label="Settings"
          active={tab === 'settings' || tab === 'debug'}
          onPress={() => setTab('settings')}
        />
      </View>
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
  hidden: { display: 'none' },
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#1f2733',
    backgroundColor: '#0b0e13',
    paddingBottom: 24,
    paddingTop: 8,
  },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 6 },
  tabText: { color: '#64748b', fontSize: 13, fontWeight: '600' },
  tabTextActive: { color: '#60a5fa' },
});
