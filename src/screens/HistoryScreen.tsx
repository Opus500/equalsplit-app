// Session history. A session = one calendar day of runs. Tap a session to see
// its runs, with a summary (best / average / count), an athlete filter, per-run
// delete, and tap-a-run to edit its athlete/drill tags. Totals are the raw gate
// measurement (the reaction correction is unreliable; see LATENCY.md). Reloads
// whenever the tab becomes active.

import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import {
  addRecentAthlete,
  deleteRun,
  getRecentAthletes,
  getRuns,
  getSessions,
  updateRunTags,
  type RunRow,
  type SessionRow,
} from '../db/database';
import { useSettings } from '../settings/SettingsProvider';
import { TagPickerModal, formatTags } from '../components/TagPicker';

const fmt = (ms: number) => (Math.max(0, ms) / 1000).toFixed(3);
// Total is the raw gate measurement; the (unreliable) reaction correction is
// applied only to the reaction in dev mode, never to the total. See LATENCY.md.
const totalOf = (r: RunRow) => r.total_ms;
const adjReaction = (r: RunRow) => Math.max(0, r.split1_ms - r.reaction_offset_ms);

// Per-run correction breakdown stored at save time (see TimerScreen applyFinish).
type RawMeta = {
  source?: 'synced' | 'fixed';
  confMs?: number;
  early?: boolean;
  implausible?: boolean;
};
const parseMeta = (r: RunRow): RawMeta => {
  if (!r.raw_json) return {};
  try {
    return JSON.parse(r.raw_json) as RawMeta;
  } catch {
    return {};
  }
};

export default function HistoryScreen({ isActive }: { isActive: boolean }) {
  const { devMode } = useSettings();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [selected, setSelected] = useState<SessionRow | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [athleteFilter, setAthleteFilter] = useState<string | null>(null);
  const [editing, setEditing] = useState<RunRow | null>(null);
  const [recents, setRecents] = useState<string[]>([]);

  const loadSessions = useCallback(async () => {
    setSessions(await getSessions());
  }, []);

  useEffect(() => {
    if (isActive && !selected) loadSessions();
  }, [isActive, selected, loadSessions]);

  useEffect(() => {
    getRecentAthletes().then(setRecents).catch(() => {});
  }, []);

  const openSession = useCallback(async (s: SessionRow) => {
    setSelected(s);
    setAthleteFilter(null);
    setRuns(await getRuns(s.id));
  }, []);

  const refreshRuns = useCallback(async () => {
    if (selected) setRuns(await getRuns(selected.id));
  }, [selected]);

  const saveEdit = useCallback(
    async (name: string, drill: string) => {
      if (!editing) return;
      await updateRunTags(editing.id, { athleteName: name, drillType: drill });
      if (name) setRecents(await addRecentAthlete(name));
      await refreshRuns();
    },
    [editing, refreshRuns],
  );

  const confirmDelete = useCallback(
    (run: RunRow) => {
      Alert.alert('Delete run', `Delete run #${run.run_index} (${fmt(totalOf(run))}s)?`, [
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
    const athletes = Array.from(
      new Set(runs.map((r) => (r.athlete_name ?? '').trim()).filter(Boolean)),
    );
    const shown = athleteFilter
      ? runs.filter((r) => (r.athlete_name ?? '').trim() === athleteFilter)
      : runs;
    const totals = shown.filter((r) => r.status === 'valid').map(totalOf);
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

        {athletes.length ? (
          <View style={styles.filterRow}>
            <FilterChip label="All" active={athleteFilter == null} onPress={() => setAthleteFilter(null)} />
            {athletes.map((a) => (
              <FilterChip
                key={a}
                label={a}
                active={athleteFilter === a}
                onPress={() => setAthleteFilter((cur) => (cur === a ? null : a))}
              />
            ))}
          </View>
        ) : null}

        <View style={styles.summary}>
          <Stat label="Runs" value={`${shown.length}`} />
          <Stat label="Best" value={best != null ? `${fmt(best)}s` : '—'} />
          <Stat label="Avg" value={avg != null ? `${fmt(avg)}s` : '—'} />
        </View>

        <FlatList
          data={shown}
          keyExtractor={(r) => r.id}
          ListEmptyComponent={<Text style={styles.empty}>No runs.</Text>}
          renderItem={({ item }) => {
            const meta = parseMeta(item);
            const tags = formatTags(item.athlete_name, item.drill_type);
            return (
              <Pressable style={styles.runRow} onPress={() => setEditing(item)}>
                <View style={styles.runLeft}>
                  <View style={styles.runLeftTop}>
                    <Text style={styles.runIdx}>#{item.run_index}</Text>
                    <Text style={styles.runMode}>M{item.mode}</Text>
                  </View>
                  <Text style={[styles.runTags, !tags && styles.runTagsEmpty]} numberOfLines={1}>
                    {tags || '+ tag'}
                  </Text>
                </View>
                <View style={{ flex: 1 }} />
                {item.mode === 2 ? (
                  <View style={styles.runM2}>
                    <Text
                      style={[styles.runSplits, devMode && meta.implausible && styles.runUnreliable]}
                    >
                      {devMode
                        ? meta.implausible
                          ? 'unreliable'
                          : fmt(adjReaction(item))
                        : fmt(item.split1_ms)}{' '}
                      / {fmt(item.split2_ms)}
                    </Text>
                    {devMode ? (
                      meta.confMs ? (
                        <Text style={styles.runConf}>reaction ±{meta.confMs} ms · synced</Text>
                      ) : (
                        <Text style={styles.runConfDim}>
                          {meta.source === 'fixed' ? 'fixed offset' : 'no ±X'}
                        </Text>
                      )
                    ) : (
                      <Text style={styles.runConfDim}>react raw · G1→G2 exact</Text>
                    )}
                  </View>
                ) : null}
                <Text style={styles.runTotal}>{fmt(totalOf(item))}s</Text>
                <Pressable onPress={() => confirmDelete(item)} hitSlop={10} style={styles.del}>
                  <Text style={styles.delText}>✕</Text>
                </Pressable>
              </Pressable>
            );
          }}
        />

        <TagPickerModal
          visible={editing != null}
          title={editing ? `Edit run #${editing.run_index}` : 'Edit run'}
          initialName={editing?.athlete_name ?? ''}
          initialDrill={editing?.drill_type ?? ''}
          recents={recents}
          onClose={() => setEditing(null)}
          onSubmit={saveEdit}
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

function FilterChip({
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
      style={({ pressed }) => [styles.fchip, active && styles.fchipActive, pressed && { opacity: 0.6 }]}
    >
      <Text style={[styles.fchipText, active && styles.fchipTextActive]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0e1116', paddingTop: 56, paddingHorizontal: 16 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 8 },
  back: { color: '#60a5fa', fontSize: 16, fontWeight: '600' },
  title: { color: '#fff', fontSize: 22, fontWeight: '800', marginBottom: 8 },
  empty: { color: '#64748b', marginTop: 24, textAlign: 'center' },
  filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 10 },
  fchip: {
    backgroundColor: '#161b22',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#243042',
    maxWidth: 160,
  },
  fchipActive: { backgroundColor: '#1d4ed8', borderColor: '#3b82f6' },
  fchipText: { color: '#cbd5e1', fontSize: 12, fontWeight: '600' },
  fchipTextActive: { color: '#fff' },
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
  runLeft: { maxWidth: 150 },
  runLeftTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  runIdx: { color: '#64748b', width: 32, fontVariant: ['tabular-nums'] },
  runMode: { color: '#94a3b8', fontWeight: '700' },
  runTags: { color: '#94a3b8', fontSize: 11, marginTop: 2 },
  runTagsEmpty: { color: '#3b4759' },
  runM2: { alignItems: 'flex-end', marginRight: 10 },
  runSplits: { color: '#64748b', fontSize: 13, fontVariant: ['tabular-nums'] },
  runUnreliable: { color: '#fb923c', fontWeight: '700' },
  runConf: { color: '#38bdf8', fontSize: 10, fontWeight: '700', marginTop: 1, fontVariant: ['tabular-nums'] },
  runConfDim: { color: '#475569', fontSize: 10, marginTop: 1 },
  runTotal: { color: '#fff', fontSize: 16, fontWeight: '800', fontVariant: ['tabular-nums'] },
  del: { paddingHorizontal: 6, paddingVertical: 2 },
  delText: { color: '#b4541f', fontSize: 16, fontWeight: '800' },
});
