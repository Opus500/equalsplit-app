// Root: BLE provider + a lightweight tab switcher. Timer stays mounted (keeps
// its BLE subscription, audio, and any in-progress run alive); History and Debug
// mount on demand so they show fresh data each time.

import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';

import { GateProvider } from './src/ble/GateProvider';
import { SettingsProvider } from './src/settings/SettingsProvider';
import { initDb } from './src/db/database';
import TimerScreen from './src/screens/TimerScreen';
import HistoryScreen from './src/screens/HistoryScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import DebugScreen from './src/screens/DebugScreen';

type Tab = 'timer' | 'history' | 'settings' | 'debug';

export default function App() {
  const [tab, setTab] = useState<Tab>('timer');

  useEffect(() => {
    initDb().catch(() => {});
  }, []);

  return (
    <SettingsProvider>
      <GateProvider>
        <View style={styles.root}>
        <StatusBar style="light" />
        <View style={styles.screens}>
          <View style={[styles.fill, tab !== 'timer' && styles.hidden]}>
            <TimerScreen />
          </View>
          {tab === 'history' && (
            <View style={styles.fill}>
              <HistoryScreen isActive={tab === 'history'} />
            </View>
          )}
          {tab === 'settings' && (
            <View style={styles.fill}>
              <SettingsScreen />
            </View>
          )}
          {tab === 'debug' && (
            <View style={styles.fill}>
              <DebugScreen />
            </View>
          )}
        </View>

        <View style={styles.tabBar}>
          <TabButton label="Timer" active={tab === 'timer'} onPress={() => setTab('timer')} />
          <TabButton label="History" active={tab === 'history'} onPress={() => setTab('history')} />
          <TabButton label="Settings" active={tab === 'settings'} onPress={() => setTab('settings')} />
          <TabButton label="Debug" active={tab === 'debug'} onPress={() => setTab('debug')} />
        </View>
        </View>
      </GateProvider>
    </SettingsProvider>
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
