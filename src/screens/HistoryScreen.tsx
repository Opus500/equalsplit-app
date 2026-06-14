// Session history. A session = one calendar day of runs. Tap a session to see
// its runs. Reloads whenever the tab becomes active so new runs show up.

import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { getRuns, getSessions, type RunRow, type SessionRow } from '../db/database';

const fmt = (ms: number) => (ms / 1000).toFixed(3);

export default function HistoryScreen({ isActive }: { isActive: boolean }) {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [selected, setSelected] = useState<SessionRow | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);

  const loadSessions = useCallback(async () => {
    setSessions(await getSessions());
  }, []);

  useEffect(() => {
    if (isActive && !selected) loadSessions();
  }, [isActive, selected, loadSessions]);

  const openSession = useCallback(async (s: SessionRow) => {
    setSelected(s);
    setRuns(await getRuns(s.id));
  }, []);

  if (selected) {
    return (
      <View style={styles.container}>
        <View style={styles.headerRow}>
          <Pressable onPress={() => setSelected(null)} hitSlop={8}>
            <Text style={styles.back}>‹ Sessions</Text>
          </Pressable>
          <Text style={styles.title}>{selected.name}</Text>
        </View>
        <FlatList
          data={runs}
          keyExtractor={(r) => r.id}
          ListEmptyComponent={<Text style={styles.empty}>No runs.</Text>}
          renderItem={({ item }) => (
            <View style={styles.runRow}>
              <Text style={styles.runIdx}>#{item.run_index}</Text>
              <Text style={styles.runMode}>M{item.mode}</Text>
              <View style={{ flex: 1 }} />
              {item.mode === 2 ? (
                <Text style={styles.runSplits}>
                  {fmt(item.split1_ms)} / {fmt(item.split2_ms)}
                </Text>
              ) : null}
              <Text style={styles.runTotal}>{fmt(item.total_ms)}s</Text>
            </View>
          )}
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>History</Text>
      <FlatList
        data={sessions}
        keyExtractor={(s) => s.id}
        ListEmptyComponent={<Text style={styles.empty}>No sessions yet. Finish a run to start one.</Text>}
        renderItem={({ item }) => (
          <Pressable style={styles.sessRow} onPress={() => openSession(item)}>
            <View>
              <Text style={styles.sessName}>{item.name}</Text>
              <Text style={styles.sessSub}>
                {item.runCount} run{item.runCount === 1 ? '' : 's'}
              </Text>
            </View>
            <View style={{ flex: 1 }} />
            {item.bestMs != null ? (
              <Text style={styles.sessBest}>best {fmt(item.bestMs)}s</Text>
            ) : null}
            <Text style={styles.chev}>›</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0e1116', paddingTop: 56, paddingHorizontal: 16 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 8 },
  back: { color: '#60a5fa', fontSize: 16, fontWeight: '600' },
  title: { color: '#fff', fontSize: 22, fontWeight: '800', marginBottom: 8 },
  empty: { color: '#64748b', marginTop: 24, textAlign: 'center' },
  sessRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#161b22',
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
  },
  sessName: { color: '#e2e8f0', fontSize: 16, fontWeight: '700' },
  sessSub: { color: '#64748b', fontSize: 13, marginTop: 2 },
  sessBest: { color: '#34d399', fontSize: 13, fontWeight: '700', marginRight: 8 },
  chev: { color: '#475569', fontSize: 22 },
  runRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1f2733',
  },
  runIdx: { color: '#64748b', width: 32, fontVariant: ['tabular-nums'] },
  runMode: { color: '#94a3b8', fontWeight: '700' },
  runSplits: { color: '#64748b', fontSize: 13, marginRight: 10, fontVariant: ['tabular-nums'] },
  runTotal: { color: '#fff', fontSize: 16, fontWeight: '800', fontVariant: ['tabular-nums'] },
});
