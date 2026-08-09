// One athlete's progress: a chart per drill, never one chart across drills.
//
// Reachable by tapping a roster row. That tap used to open the edit form; the form
// is now a button in here, because "who is this athlete" is a more useful answer to
// a tap on a name than "rename this athlete".

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  type LayoutChangeEvent,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { deleteRun, getAthleteRuns, type Athlete, type AthleteRunRow } from '../db/database';
import { runCountLabel } from '../roster/labels';
import { useRoster } from '../roster/RosterProvider';
import {
  MIN_SERIES_RUNS,
  buildProgression,
  formatMs,
  type Progression,
  type Series,
} from '../roster/progression';
import { ProgressionChart } from './ProgressionChart';

export function AthleteDetailModal({
  visible,
  athlete,
  onClose,
  onEdit,
  children,
}: {
  visible: boolean;
  athlete: Athlete | null;
  onClose: () => void;
  onEdit: () => void;
  /** Rendered INSIDE this modal. The edit form goes here: on iOS, dismissing one
   *  root-level Modal while presenting another in the same frame can drop the
   *  second, so a modal opened from this one must be nested, not a sibling. */
  children?: React.ReactNode;
}) {
  const [rows, setRows] = useState<AthleteRunRow[] | null>(null);
  // Deleting a run changes the athlete's run_count, which the roster row and every
  // picker render — refresh the provider so they don't go stale behind this sheet.
  const roster = useRoster();

  useEffect(() => {
    if (!visible || !athlete) {
      setRows(null);
      return;
    }
    let alive = true;
    getAthleteRuns(athlete.id)
      .then((r) => alive && setRows(r))
      .catch(() => alive && setRows([]));
    return () => {
      alive = false;
    };
  }, [visible, athlete]);

  // Only VALID runs are charted. A suspect run is usually an early break or a false
  // trigger, which lands as an impossibly fast time — exactly the shape of a huge
  // PB. Charting it would invent a personal best that never happened.
  const { prog, excluded } = useMemo((): { prog: Progression | null; excluded: number } => {
    if (!rows) return { prog: null, excluded: 0 };
    const valid = rows.filter((r) => r.status === 'valid');
    return {
      prog: buildProgression(
        valid.map((r) => ({
          id: r.id,
          drillId: r.drill_id,
          drillName: r.drill_name,
          elapsedMs: r.total_ms,
          createdAt: r.created_at,
        })),
      ),
      excluded: rows.length - valid.length,
    };
  }, [rows]);

  const graphable = prog?.series.filter((s) => s.graphable) ?? [];
  const thin = prog?.series.filter((s) => !s.graphable) ?? [];

  /**
   * Delete a run from the chart. A REAL delete through the same deleteRun() path
   * History uses — not a chart-level exclusion — so the two can never disagree
   * about which runs exist.
   *
   * For junk data (a false start, someone walking through the beam), not a bad
   * rep. The confirm names the time and date so it can't take the wrong point.
   *
   * Deliberately does NOT touch the queue: revertAdvance() is for discarding the
   * run that just happened, and un-advancing a cursor because of something deleted
   * from last week's history would be nonsense.
   */
  const confirmDeleteRun = useCallback(
    (runId: string) => {
      const row = rows?.find((r) => r.id === runId);
      if (!row) return;
      const when = new Date(row.created_at).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
      Alert.alert(
        'Delete this run?',
        `${(row.total_ms / 1000).toFixed(2)}s · ${row.drill_name ?? 'no drill'} · ${when}\n\n` +
          'Deleted everywhere, including History. This cannot be undone.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete run',
            style: 'destructive',
            onPress: async () => {
              try {
                await deleteRun(runId);
                setRows((prev) => prev?.filter((r) => r.id !== runId) ?? null);
                // Run counts on the roster row change too.
                await roster.refresh();
              } catch (e) {
                Alert.alert('Delete failed', String(e));
              }
            },
          },
        ],
      );
    },
    [rows, roster],
  );

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet">
      <View style={styles.container}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.name} numberOfLines={1}>
              {athlete?.display_name ?? ''}
            </Text>
            <Text style={styles.sub} numberOfLines={1}>
              {[
                athlete?.archived_at ? 'archived' : null,
                athlete?.group_name || null,
                runCountLabel(athlete?.run_count ?? 0),
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          </View>
          <Pressable onPress={onEdit} hitSlop={8} style={({ pressed }) => [styles.hdrBtn, pressed && styles.dim]}>
            <Text style={styles.hdrBtnText}>Edit</Text>
          </Pressable>
          <Pressable onPress={onClose} hitSlop={10} style={({ pressed }) => [styles.close, pressed && styles.dim]}>
            <Text style={styles.closeText}>Done</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
          {rows == null ? (
            <Text style={styles.muted}>Loading runs…</Text>
          ) : rows.length === 0 ? (
            <View style={styles.emptyCard}>
              <Text style={styles.emptyTitle}>No runs yet</Text>
              <Text style={styles.emptyBody}>
                Times appear here once this athlete is up on the strip when a run finishes.
              </Text>
            </View>
          ) : (
            <>
              <ChartPager series={graphable} onDeleteRun={confirmDeleteRun} />

              {/* Series that exist but can't be drawn yet. Listed rather than hidden:
                  "two more runs and this becomes a chart" is actionable; a blank
                  screen is not. */}
              {thin.length ? (
                <View style={styles.thinCard}>
                  <Text style={styles.thinTitle}>
                    {graphable.length ? 'OTHER DRILLS — NOT ENOUGH DATA YET' : 'NOT ENOUGH DATA YET'}
                  </Text>
                  {thin.map((s) => (
                    <View key={s.drillId} style={styles.thinRow}>
                      <Text style={styles.thinName} numberOfLines={1}>
                        {s.drillName}
                      </Text>
                      <Text style={styles.thinCount}>
                        {s.points.length} run{s.points.length === 1 ? '' : 's'} · best{' '}
                        {formatMs(s.bestMs)}s
                      </Text>
                      <Text style={styles.thinNeed}>
                        +{MIN_SERIES_RUNS - s.points.length} to chart
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}

              {!graphable.length && !thin.length ? (
                <View style={styles.emptyCard}>
                  <Text style={styles.emptyTitle}>Nothing to chart yet</Text>
                  <Text style={styles.emptyBody}>
                    {prog && prog.unlabeledRuns > 0
                      ? `All ${prog.unlabeledRuns} of this athlete's runs were saved without a drill. Progress is tracked per drill, so a 30m and a 40yd never share an axis — set a drill on the timer and new runs will chart.`
                      : 'No runs with a drill label yet.'}
                  </Text>
                </View>
              ) : null}

              {/* Every run this screen set aside, and why. */}
              {prog && (prog.unlabeledRuns > 0 || excluded > 0) ? (
                <Text style={styles.footnote}>
                  {[
                    prog.unlabeledRuns > 0
                      ? `${prog.unlabeledRuns} run${prog.unlabeledRuns === 1 ? '' : 's'} without a drill label ${
                          prog.unlabeledRuns === 1 ? 'is' : 'are'
                        } not charted`
                      : null,
                    excluded > 0
                      ? `${excluded} suspect or invalid run${excluded === 1 ? '' : 's'} excluded`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  .
                </Text>
              ) : null}
            </>
          )}
        </ScrollView>

        {children}
      </View>
    </Modal>
  );
}

/**
 * One drill chart at a time, swiped horizontally.
 *
 * Paging is RN's own `pagingEnabled` ScrollView — no new dependency. Pages are
 * sized to the MEASURED container rather than the window, so the modal's padding
 * doesn't leave each page a fraction off and drift the snap across swipes.
 *
 * The dots are the only signal that more charts exist, so they are also the
 * shortcut to reach them: tappable, with hitSlop, since a 7px dot is not a target.
 */
function ChartPager({
  series,
  onDeleteRun,
}: {
  series: Series[];
  onDeleteRun?: (runId: string) => void;
}) {
  const [pageW, setPageW] = useState(0);
  const [page, setPage] = useState(0);
  const ref = useRef<ScrollView>(null);

  // Archiving a drill's runs (or a filter change) can shorten the list under us;
  // without this the pager would sit on a page that no longer exists.
  useEffect(() => {
    if (page > series.length - 1) setPage(Math.max(0, series.length - 1));
  }, [series.length, page]);

  const onLayout = (e: LayoutChangeEvent) => setPageW(e.nativeEvent.layout.width);
  const onEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!pageW) return;
    setPage(Math.round(e.nativeEvent.contentOffset.x / pageW));
  };

  const goTo = (i: number) => {
    setPage(i);
    ref.current?.scrollTo({ x: i * pageW, animated: true });
  };

  if (!series.length) return null;
  if (series.length === 1)
    return <ProgressionChart series={series[0]!} onDeleteRun={onDeleteRun} />;

  return (
    <View onLayout={onLayout}>
      {pageW > 0 ? (
        <>
          <ScrollView
            ref={ref}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={onEnd}
            decelerationRate="fast"
          >
            {series.map((s) => (
              <View key={s.drillId} style={{ width: pageW }}>
                <ProgressionChart series={s} onDeleteRun={onDeleteRun} />
              </View>
            ))}
          </ScrollView>

          <View style={styles.dots}>
            {series.map((s, i) => (
              <Pressable
                key={s.drillId}
                onPress={() => goTo(i)}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel={`Show ${s.drillName} chart, ${i + 1} of ${series.length}`}
                style={styles.dotHit}
              >
                <View style={[styles.dot, i === page && styles.dotOn]} />
              </Pressable>
            ))}
            <Text style={styles.pagerLabel}>
              {page + 1} / {series.length}
            </Text>
          </View>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0e1116' },
  dots: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 2, marginTop: 2 },
  dotHit: { paddingHorizontal: 5, paddingVertical: 8 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#334155' },
  dotOn: { backgroundColor: '#60a5fa', width: 8, height: 8, borderRadius: 4 },
  pagerLabel: { color: '#475569', fontSize: 11, marginLeft: 8, fontVariant: ['tabular-nums'] },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#243042',
  },
  headerText: { flex: 1, minWidth: 0 },
  name: { color: '#fff', fontSize: 20, fontWeight: '800' },
  sub: { color: '#64748b', fontSize: 12, marginTop: 3 },
  hdrBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#243042',
  },
  hdrBtnText: { color: '#94a3b8', fontSize: 13, fontWeight: '700' },
  close: { paddingHorizontal: 6, paddingVertical: 8 },
  closeText: { color: '#60a5fa', fontSize: 15, fontWeight: '800' },
  body: { padding: 16, paddingBottom: 40 },
  muted: { color: '#64748b', textAlign: 'center', marginTop: 32 },
  emptyCard: {
    backgroundColor: '#161b22',
    borderRadius: 14,
    padding: 18,
    borderWidth: 1,
    borderColor: '#243042',
  },
  emptyTitle: { color: '#e2e8f0', fontSize: 15, fontWeight: '800' },
  emptyBody: { color: '#64748b', fontSize: 13, lineHeight: 19, marginTop: 6 },
  thinCard: {
    backgroundColor: '#12151b',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#243042',
  },
  thinTitle: { color: '#94a3b8', fontSize: 12, fontWeight: '800', letterSpacing: 0.5, marginBottom: 8 },
  thinRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#1c2432',
  },
  thinName: { color: '#cbd5e1', fontSize: 14, fontWeight: '700', flex: 1 },
  thinCount: { color: '#64748b', fontSize: 11 },
  thinNeed: { color: '#475569', fontSize: 11, fontWeight: '700' },
  footnote: { color: '#475569', fontSize: 11, lineHeight: 16, marginTop: 14 },
  dim: { opacity: 0.5 },
});
