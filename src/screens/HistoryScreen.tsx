// Session history. A session = one calendar day of runs. Tap a session to see
// its runs, with a summary (best / average / count) and per-run delete. Times
// shown are adjusted (raw total minus the stored reaction offset); Mode 1 has
// offset 0 so adjusted == raw. Reloads whenever the tab becomes active.

import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { deleteRun, getRuns, getSessions, type RunRow, type SessionRow } from '../db/database';

const fmt = (ms: number) => (Math.max(0, ms) / 1000).toFixed(3);
const adjTotal = (r: RunRow) => Math.max(0, r.total_ms - r.reaction_offset_ms);
const adjReaction = (r: RunRow) => Math.max(0, r.split1_ms - r.reaction_offset_ms);

// Per-run correction breakdown stored at save time (see TimerScreen applyFinish).
type RawMeta = { source?: 'synced' | 'fixed'; confMs?: number; early?: boolean };
const parseMeta = (r: RunRow): RawMeta => {
  if (!r.raw_json) return {};
  try {
    return JSON.parse(r.raw_json) as RawMeta;
  } catch {
    return {};
  }
};

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

  const confirmDelete = useCallback(
    (run: RunRow) => {
      Alert.alert('Delete run', `Delete run #${run.run_index} (${fmt(adjTotal(run))}s)?`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await deleteRun(run.id);
            if (!selected) return;
            const remaining = await getRuns(selected.id);
            if (remaining.length === 0) {
              setSelected(null);
              await loadSessions();
            } else {
              setRuns(remaining);
            }
          },
        },
      ]);
    },
    [selected, loadSessions],
  );

  if (selected) {
    const valid = runs.filter((r) => r.status === 'valid');
    const totals = valid.map(adjTotal);
    const best = totals.length ? Math.min(...totals) : null;
    const avg = totals.length ? totals.reduce((a, b) => a + b, 0) / totals.length : null;

    return (
      <View style={styles.container}>
        <View style={styles.headerRow}>
          <Pressable onPress={() => setSelected(null)} hitSlop={8}>
            <Text style={styles.back}>‹ Sessions</Text>
          </Pressable>
          <Text style={styles.title}>{selected.name}</Text>
        </View>

        <View style={styles.summary}>
          <Stat label="Runs" value={`${runs.length}`} />
          <Stat label="Best" value={best != null ? `${fmt(best)}s` : '—'} />
          <Stat label="Avg" value={avg != null ? `${fmt(avg)}s` : '—'} />
        </View>

        <FlatList
          data={runs}
          keyExtractor={(r) => r.id}
          ListEmptyComponent={<Text style={styles.empty}>No runs.</Text>}
          renderItem={({ item }) => {
            const meta = parseMeta(item);
            return (
              <View style={styles.runRow}>
                <Text style={styles.runIdx}>#{item.run_index}</Text>
                <Text style={styles.runMode}>M{item.mode}</Text>
                <View style={{ flex: 1 }} />
                {item.mode === 2 ? (
                  <View style={styles.runM2}>
                    <Text style={styles.runSplits}>
                      {fmt(adjReaction(item))} / {fmt(item.split2_ms)}
                    </Text>
                    {meta.confMs ? (
                      <Text style={styles.runConf}>reaction ±{meta.confMs} ms · synced</Text>
                    ) : (
                      <Text style={styles.runConfDim}>
                        {meta.source === 'fixed' ? 'fixed offset' : 'no ±X'}
                      </Text>
                    )}
                  </View>
                ) : null}
                <Text style={styles.runTotal}>{fmt(adjTotal(item))}s</Text>
                <Pressable onPress={() => confirmDelete(item)} hitSlop={10} style={styles.del}>
                  <Text style={styles.delText}>✕</Text>
                </Pressable>
              </View>
            );
          }}
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
            {item.bestMs != null ? <Text style={styles.sessBest}>best {fmt(item.bestMs)}s</Text> : null}
            <Text style={styles.chev}>›</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statVal}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0e1116', paddingTop: 56, paddingHorizontal: 16 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 8 },
  back: { color: '#60a5fa', fontSize: 16, fontWeight: '600' },
  title: { color: '#fff', fontSize: 22, fontWeight: '800', marginBottom: 8 },
  empty: { color: '#64748b', marginTop: 24, textAlign: 'center' },
  summary: {
    flexDirection: 'row',
    backgroundColor: '#161b22',
    borderRadius: 12,
    paddingVertical: 12,
    marginBottom: 12,
  },
  stat: { flex: 1, alignItems: 'center' },
  statVal: { color: '#fff', fontSize: 18, fontWeight: '800', fontVariant: ['tabular-nums'] },
  statLabel: { color: '#64748b', fontSize: 12, marginTop: 2 },
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
  runM2: { alignItems: 'flex-end', marginRight: 10 },
  runSplits: { color: '#64748b', fontSize: 13, fontVariant: ['tabular-nums'] },
  runConf: { color: '#38bdf8', fontSize: 10, fontWeight: '700', marginTop: 1, fontVariant: ['tabular-nums'] },
  runConfDim: { color: '#475569', fontSize: 10, marginTop: 1 },
  runTotal: { color: '#fff', fontSize: 16, fontWeight: '800', fontVariant: ['tabular-nums'] },
  del: { paddingHorizontal: 6, paddingVertical: 2 },
  delText: { color: '#b4541f', fontSize: 16, fontWeight: '800' },
});
