// One-time test-data cleanup. Reached from Diagnostics (dev mode only).
//
// Deliberately NOT a "clear history" button. The flow is: see the distribution →
// pick a cutoff from it → read what that would delete → confirm twice. You cannot
// reach the delete without having been shown the count first.
//
// The predicate is `athlete_id IS NULL AND created_at < cutoff` (../runs/prune.ts).
// Unassigned ALONE would be unsafe as a standing control — standalone B1 runs save
// unassigned by design — so the date bound is what makes this a one-time cleanup
// rather than a permanent hazard sitting in the app.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  listRunsForPrune,
  pruneUnassignedRunsBefore,
  sampleRunsToPrune,
} from '../db/database';
import {
  bucketRuns,
  cutoffForBucket,
  summarize,
  type Bucket,
  type Period,
  type PrunableRun,
} from '../runs/prune';

const fmt = (ms: number) => (Math.max(0, ms) / 1000).toFixed(2);
const shortDate = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: '2-digit' });

export function PruneTestDataModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const [runs, setRuns] = useState<PrunableRun[] | null>(null);
  const [period, setPeriod] = useState<Period>('week');
  const [chosen, setChosen] = useState<Bucket | null>(null);
  const [sample, setSample] = useState<
    { id: string; total_ms: number; created_at: number; drill_name: string | null }[]
  >([]);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setRuns(await listRunsForPrune());
    } catch {
      setRuns([]);
    }
  }, []);

  useEffect(() => {
    if (!visible) {
      setChosen(null);
      setSample([]);
      return;
    }
    reload();
  }, [visible, reload]);

  const buckets = useMemo(() => (runs ? bucketRuns(runs, period) : []), [runs, period]);
  // Re-pick the equivalent bucket when the period changes, rather than silently
  // keeping a week's cutoff while showing months.
  useEffect(() => setChosen(null), [period]);

  const summary = useMemo(
    () => (runs && chosen ? summarize(runs, cutoffForBucket(chosen)) : null),
    [runs, chosen],
  );

  const pick = useCallback(async (b: Bucket) => {
    setChosen(b);
    try {
      setSample(await sampleRunsToPrune(cutoffForBucket(b), 5));
    } catch {
      setSample([]);
    }
  }, []);

  const doPrune = useCallback(() => {
    if (!chosen || !summary || summary.matched === 0 || busy) return;
    // Step 1 of 2. The count and the boundary are both in the message, because
    // "are you sure" without them is a button people press without reading.
    Alert.alert(
      `Delete ${summary.matched} run${summary.matched === 1 ? '' : 's'}?`,
      `Unassigned runs before ${shortDate(chosen.end)}.\n\n` +
        `${summary.attributed} attributed run${summary.attributed === 1 ? '' : 's'} and ` +
        `${summary.spared} newer unassigned run${summary.spared === 1 ? '' : 's'} are kept. ` +
        'Athletes and drills are not affected.\n\nThis cannot be undone from the app.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Continue',
          style: 'destructive',
          onPress: () => {
            // Step 2 of 2, deliberately not chained into the first tap.
            Alert.alert(
              'Confirm delete',
              `Permanently delete ${summary.matched} run${summary.matched === 1 ? '' : 's'}. ` +
                'Make sure your database backup is current.',
              [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Delete',
                  style: 'destructive',
                  onPress: async () => {
                    setBusy(true);
                    try {
                      const r = await pruneUnassignedRunsBefore(cutoffForBucket(chosen));
                      setChosen(null);
                      setSample([]);
                      await reload();
                      Alert.alert(
                        'Pruned',
                        `${r.runsDeleted} run${r.runsDeleted === 1 ? '' : 's'} deleted` +
                          (r.sessionsDeleted
                            ? `, ${r.sessionsDeleted} empty session${
                                r.sessionsDeleted === 1 ? '' : 's'
                              } removed.`
                            : '.'),
                      );
                    } catch (e) {
                      Alert.alert('Prune failed', String(e));
                    } finally {
                      setBusy(false);
                    }
                  },
                },
              ],
            );
          },
        },
      ],
    );
  }, [chosen, summary, busy, reload]);

  const totalUnassigned = useMemo(
    () => (runs ? runs.filter((r) => r.athleteId == null).length : 0),
    [runs],
  );

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet">
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Prune test data</Text>
          <Pressable onPress={onClose} hitSlop={10} style={({ pressed }) => pressed && styles.dim}>
            <Text style={styles.done}>Done</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.body}>
          {runs == null ? (
            <Text style={styles.muted}>Loading…</Text>
          ) : (
            <>
              <Text style={styles.intro}>
                Deletes runs with <Text style={styles.mono}>no athlete</Text> before a cutoff you
                pick. Runs with a drill but no athlete <Text style={styles.strong}>are</Text>{' '}
                included — the rule is about attribution, not labels.
              </Text>
              <Text style={styles.stat}>
                {runs.length} runs · {totalUnassigned} unassigned
              </Text>

              <View style={styles.segRow}>
                {(['week', 'month'] as Period[]).map((p) => (
                  <Pressable
                    key={p}
                    onPress={() => setPeriod(p)}
                    style={({ pressed }) => [
                      styles.seg,
                      period === p && styles.segOn,
                      pressed && styles.dim,
                    ]}
                  >
                    <Text style={[styles.segText, period === p && styles.segTextOn]}>
                      By {p}
                    </Text>
                  </Pressable>
                ))}
              </View>

              <Text style={styles.sectionLabel}>
                WHEN THE RUNS HAPPENED — TAP TO CUT OFF THERE
              </Text>
              {buckets.length === 0 ? (
                <Text style={styles.muted}>No runs.</Text>
              ) : (
                buckets.map((b) => {
                  const all = b.total > 0 && b.unassigned === b.total;
                  const on = chosen?.key === b.key;
                  return (
                    <Pressable
                      key={b.key}
                      onPress={() => pick(b)}
                      style={({ pressed }) => [styles.row, on && styles.rowOn, pressed && styles.dim]}
                    >
                      <Text style={[styles.rowLabel, on && styles.rowLabelOn]} numberOfLines={1}>
                        {b.label}
                      </Text>
                      {/* A bar makes an all-unassigned week obvious at a glance,
                          which is the whole point of showing the distribution. */}
                      <View style={styles.barTrack}>
                        <View
                          style={[
                            styles.barFill,
                            all && styles.barFillAll,
                            { width: `${Math.round((b.unassigned / b.total) * 100)}%` },
                          ]}
                        />
                      </View>
                      <Text style={[styles.rowCount, all && styles.rowCountAll]}>
                        {b.unassigned}/{b.total}
                      </Text>
                    </Pressable>
                  );
                })
              )}

              {chosen && summary ? (
                <View style={styles.preview}>
                  <Text style={styles.previewTitle}>
                    Cutoff: before {shortDate(chosen.end)}
                  </Text>
                  <PreviewLine label="Would delete" value={`${summary.matched}`} tone="bad" />
                  <PreviewLine
                    label="…of which carry a drill"
                    value={`${summary.matchedWithDrill}`}
                  />
                  <PreviewLine label="Kept — attributed" value={`${summary.attributed}`} tone="good" />
                  <PreviewLine
                    label="Kept — unassigned but newer"
                    value={`${summary.spared}`}
                    tone="good"
                  />

                  {sample.length ? (
                    <>
                      <Text style={styles.sampleLabel}>SAMPLE OF WHAT GOES</Text>
                      {sample.map((s) => (
                        <Text key={s.id} style={styles.sampleRow} numberOfLines={1}>
                          {fmt(s.total_ms)}s · {s.drill_name ?? 'no drill'} ·{' '}
                          {shortDate(s.created_at)}
                        </Text>
                      ))}
                    </>
                  ) : null}

                  <Pressable
                    onPress={doPrune}
                    disabled={summary.matched === 0 || busy}
                    style={({ pressed }) => [
                      styles.dangerBtn,
                      (summary.matched === 0 || busy || pressed) && styles.dim,
                    ]}
                  >
                    <Text style={styles.dangerText}>
                      {summary.matched === 0
                        ? 'Nothing matches this cutoff'
                        : `Delete ${summary.matched} run${summary.matched === 1 ? '' : 's'}…`}
                    </Text>
                  </Pressable>
                </View>
              ) : (
                <Text style={styles.hint}>Pick a period above to see what would be deleted.</Text>
              )}
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

function PreviewLine({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'good' | 'bad';
}) {
  return (
    <View style={styles.pvRow}>
      <Text style={styles.pvLabel}>{label}</Text>
      <Text
        style={[styles.pvValue, tone === 'bad' && styles.pvBad, tone === 'good' && styles.pvGood]}
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0e1116' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#243042',
  },
  title: { color: '#fff', fontSize: 19, fontWeight: '800' },
  done: { color: '#60a5fa', fontSize: 15, fontWeight: '800' },
  body: { padding: 16, paddingBottom: 48 },
  muted: { color: '#64748b', marginTop: 20, textAlign: 'center' },
  intro: { color: '#94a3b8', fontSize: 13, lineHeight: 19 },
  strong: { color: '#fbbf24', fontWeight: '800' },
  mono: { color: '#e2e8f0', fontWeight: '700' },
  stat: { color: '#64748b', fontSize: 12, marginTop: 8 },
  segRow: { flexDirection: 'row', gap: 8, marginTop: 16, marginBottom: 18 },
  seg: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 9,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: '#243042',
  },
  segOn: { backgroundColor: '#1e3a5f', borderColor: '#3b82f6' },
  segText: { color: '#94a3b8', fontSize: 13, fontWeight: '700' },
  segTextOn: { color: '#dbeafe' },
  sectionLabel: { color: '#64748b', fontSize: 10, fontWeight: '800', letterSpacing: 0.7, marginBottom: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 10,
    borderRadius: 10,
    marginBottom: 4,
  },
  rowOn: { backgroundColor: '#16233a' },
  rowLabel: { color: '#cbd5e1', fontSize: 13, width: 118 },
  rowLabelOn: { color: '#fff', fontWeight: '700' },
  barTrack: { flex: 1, height: 8, borderRadius: 4, backgroundColor: '#1c2432', overflow: 'hidden' },
  barFill: { height: 8, backgroundColor: '#3b82f6' },
  barFillAll: { backgroundColor: '#b45309' },
  rowCount: { color: '#64748b', fontSize: 11, width: 52, textAlign: 'right', fontVariant: ['tabular-nums'] },
  rowCountAll: { color: '#fbbf24', fontWeight: '700' },
  hint: { color: '#475569', fontSize: 12, marginTop: 18, textAlign: 'center' },
  preview: {
    marginTop: 20,
    backgroundColor: '#12151b',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#243042',
  },
  previewTitle: { color: '#e2e8f0', fontSize: 14, fontWeight: '800', marginBottom: 10 },
  pvRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, gap: 12 },
  pvLabel: { color: '#94a3b8', fontSize: 13, flex: 1 },
  pvValue: { color: '#cbd5e1', fontSize: 14, fontWeight: '800', fontVariant: ['tabular-nums'] },
  pvBad: { color: '#f87171' },
  pvGood: { color: '#4ade80' },
  sampleLabel: {
    color: '#475569',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.7,
    marginTop: 14,
    marginBottom: 6,
  },
  sampleRow: { color: '#64748b', fontSize: 12, paddingVertical: 2 },
  dangerBtn: {
    marginTop: 16,
    backgroundColor: '#1a1214',
    borderWidth: 1,
    borderColor: '#7f1d1d',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
  },
  dangerText: { color: '#f87171', fontSize: 14, fontWeight: '800' },
  dim: { opacity: 0.5 },
});
