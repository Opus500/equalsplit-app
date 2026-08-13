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
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import * as ImagePicker from 'expo-image-picker';

import {
  deleteRun,
  getAthleteRuns,
  setRunClip,
  setRunNote,
  type Athlete,
  type AthleteRunRow,
} from '../db/database';
import { importClip } from '../video/clips';
import { seriesTimeSource } from '../video/timing';
import { VideoPlayerModal } from './VideoPlayerModal';
import {
  HAND_START_ERROR_MS,
  REPEAT_MODE,
  parseRepSetJson,
  runStartSource,
  savedChartValueMs,
} from '../ble/repeats';
import { runCountLabel } from '../roster/labels';
import { useRoster } from '../roster/RosterProvider';
import {
  MIN_SERIES_RUNS,
  buildProgression,
  formatMs,
  seriesTitle,
  seriesUid,
  type Progression,
  type Series,
  type SeriesPoint,
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
  // Lifted out of the chart so the run list below can drive the highlight and the
  // two can never disagree about which run is selected. Keyed on the run id, not
  // an index, so a delete can't silently retarget it.
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
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
        valid.map((r) => {
          // A rep set is ONE point, never one per interval — the x-axis means
          // "one effort per point", and a line between rep 3 of Monday and rep 1
          // of Thursday would span a rest day at the same visual weight as the
          // 90s between two reps. WHICH value that point takes differs by variant
          // (total for continuous, mean for rest); savedChartValueMs owns that
          // rule, so the graph cannot drift from what the review screen showed.
          const rep = r.mode === REPEAT_MODE ? parseRepSetJson(r.raw_json) : null;
          const elapsedMs =
            (r.mode === REPEAT_MODE ? savedChartValueMs(r.raw_json, r.total_ms) : null) ??
            r.total_ms;
          return {
            id: r.id,
            drillId: r.drill_id,
            drillName: r.drill_name,
            elapsedMs,
            createdAt: r.created_at,
            // Drill AND source. A gate time and a video time of the same distance
            // are not comparable — the bias between them is systematic — so they
            // are kept in separate series rather than trusted to a naming habit.
            timeSource: seriesTimeSource(r.raw_json),
            userNote: r.note,
            // From the COLUMN, not raw_json. Attaching footage to a gate run must
            // not touch how it was timed, or it would move series.
            clipId: r.clip_id,
            // Splits stay reachable in the readout without touching the axis;
            // and a hand-started run says so, because the accuracy fact lives
            // on the row (runStartSource) rather than only in the UI.
            note:
              rep?.intervals.length
                ? `${rep.intervals.length} × ${rep.intervals.map((ms) => (ms / 1000).toFixed(2)).join(' / ')}`
                : runStartSource(r.raw_json) === 'tap'
                  ? `hand-started · ±${HAND_START_ERROR_MS}ms`
                  : null,
          };
        }),
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
                setSelectedRunId((cur) => (cur === runId ? null : cur));
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

  /**
   * Add or edit the coach's note on a run.
   *
   * Alert.prompt rather than an inline TextInput: it is a system control, so it
   * cannot be laid out wrong, and the last inline field added to this app shipped
   * invisible because a row style carrying flex:1 was reused in a column. That is
   * a poor trade when the editor can't be checked on a device first. Swapping it
   * for an inline field later touches only this function.
   */
  const editNote = useCallback(
    (runId: string) => {
      const row = rows?.find((r) => r.id === runId);
      if (!row) return;
      const save = async (text: string | undefined) => {
        try {
          const next = text?.trim() ? text.trim() : null;
          await setRunNote(runId, next);
          setRows((prev) => prev?.map((r) => (r.id === runId ? { ...r, note: next } : r)) ?? null);
        } catch (e) {
          Alert.alert('Could not save note', String(e));
        }
      };
      if (Platform.OS !== 'ios') {
        // Android has no Alert.prompt. iOS-first app; rather than ship a silently
        // dead button, say so plainly until an inline editor exists.
        Alert.alert('Notes need iOS for now', 'The note editor is not built for Android yet.');
        return;
      }
      Alert.prompt(
        row.note ? 'Edit note' : 'Add a note',
        `${(row.total_ms / 1000).toFixed(2)}s · ${row.drill_name ?? 'no drill'}`,
        [
          { text: 'Cancel', style: 'cancel' },
          ...(row.note
            ? [{ text: 'Clear', style: 'destructive' as const, onPress: () => void save('') }]
            : []),
          { text: 'Save', onPress: (text?: string) => void save(text) },
        ],
        'plain-text',
        row.note ?? '',
      );
    },
    [rows],
  );

  /**
   * Attach a video to a run that already exists.
   *
   * Writes clip_id and NOTHING else. The run keeps its time, its mode and its
   * raw_json, so a gate-timed run stays gate-timed and stays in its own
   * progression series — attaching review footage is not a claim about how the
   * run was measured.
   */
  const attachVideo = useCallback(
    async (runId: string) => {
      try {
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) {
          Alert.alert('Photo access needed', 'EqualSplit needs to read the clip you recorded.');
          return;
        }
        const res = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['videos'],
          allowsEditing: false,
          videoExportPreset: ImagePicker.VideoExportPreset.Passthrough,
          shouldDownloadFromNetwork: true,
        });
        if (res.canceled || !res.assets[0]) return;
        const imported = await importClip(res.assets[0].uri);
        await setRunClip(runId, imported.id);
        setRows((prev) => prev?.map((r) => (r.id === runId ? { ...r, clip_id: imported.id } : r)) ?? null);
      } catch (e) {
        Alert.alert('Could not attach that video', String(e));
      }
    },
    [],
  );

  const [playing, setPlaying] = useState<{ clipId: string; title: string; sub: string } | null>(null);

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
              <ChartPager
                series={graphable}
                onDeleteRun={confirmDeleteRun}
                onEditNote={editNote}
                onAttachVideo={(id) => void attachVideo(id)}
                onPlayVideo={(p, s) =>
                  setPlaying({
                    clipId: p.clipId!,
                    title: `${formatMs(p.elapsedMs)}s · ${s.drillName}`,
                    sub: `${athlete?.display_name ?? ''} · ${new Date(p.createdAt).toLocaleDateString()}`,
                  })
                }
                selectedRunId={selectedRunId}
                onSelectRun={setSelectedRunId}
              />

              {/* Series that exist but can't be drawn yet. Listed rather than hidden:
                  "two more runs and this becomes a chart" is actionable; a blank
                  screen is not. */}
              {thin.length ? (
                <View style={styles.thinCard}>
                  <Text style={styles.thinTitle}>
                    {graphable.length ? 'OTHER DRILLS — NOT ENOUGH DATA YET' : 'NOT ENOUGH DATA YET'}
                  </Text>
                  {thin.map((s) => (
                    <View key={seriesUid(s)} style={styles.thinRow}>
                      <Text style={styles.thinName} numberOfLines={1}>
                        {seriesTitle(s)}
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
                      ? `All ${prog.unlabeledRuns} of this athlete's runs were saved without a drill.`
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

        {/* Nested inside this modal, not a sibling — same iOS constraint as the
            edit form: dismissing one root-level Modal while presenting another in
            the same frame can drop the second. */}
        <VideoPlayerModal
          visible={!!playing}
          clipId={playing?.clipId ?? null}
          title={playing?.title}
          subtitle={playing?.sub}
          onClose={() => setPlaying(null)}
        />

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
  onEditNote,
  onAttachVideo,
  onPlayVideo,
  selectedRunId,
  onSelectRun,
}: {
  series: Series[];
  onDeleteRun?: (runId: string) => void;
  onEditNote?: (runId: string) => void;
  onAttachVideo?: (runId: string) => void;
  onPlayVideo?: (point: SeriesPoint, series: Series) => void;
  selectedRunId: string | null;
  onSelectRun: (runId: string | null) => void;
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

  // The list always describes the chart currently on screen — "that series only".
  const current = series[Math.min(page, series.length - 1)];
  const runList = current ? (
    <RunList
      series={current}
      selectedRunId={selectedRunId}
      onSelectRun={onSelectRun}
      onDeleteRun={onDeleteRun}
      onEditNote={onEditNote}
      onAttachVideo={onAttachVideo}
      onPlayVideo={onPlayVideo}
    />
  ) : null;

  if (series.length === 1)
    return (
      <>
        <ProgressionChart
          series={series[0]!}
          onDeleteRun={onDeleteRun}
          selectedRunId={selectedRunId}
          onSelectRun={onSelectRun}
        />
        {runList}
      </>
    );

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
            {/* seriesUid, not drillId: since the source split one drill can produce
                both a gate and a video series, and duplicate keys would let React
                reuse the wrong chart's state. */}
            {series.map((s) => (
              <View key={seriesUid(s)} style={{ width: pageW }}>
                <ProgressionChart
                  series={s}
                  onDeleteRun={onDeleteRun}
                  selectedRunId={selectedRunId}
                  onSelectRun={onSelectRun}
                />
              </View>
            ))}
          </ScrollView>

          <View style={styles.dots}>
            {series.map((s, i) => (
              <Pressable
                key={seriesUid(s)}
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

          {runList}
        </>
      ) : null}
    </View>
  );
}

/**
 * The runs behind the chart above — that series only, newest first.
 *
 * The chart answers "what is the shape"; this answers "which run was that, and
 * what happened". Tapping a row selects it in both places (selection is lifted and
 * keyed on run id), so the readout and the list can never point at different runs.
 *
 * Newest first, against the chart's oldest-left ordering: a coach scanning a list
 * is looking for what just happened, while a chart has to read left-to-right in
 * time. Same data, different questions.
 *
 * The expanded row is also where a video will hang later — one more line under the
 * note, next to the existing actions. Nothing here assumes there is only ever a
 * time, which is why the actions are a row rather than a pair of fixed buttons.
 */
function RunList({
  series,
  selectedRunId,
  onSelectRun,
  onDeleteRun,
  onEditNote,
  onAttachVideo,
  onPlayVideo,
}: {
  series: Series;
  selectedRunId: string | null;
  onSelectRun: (runId: string | null) => void;
  onDeleteRun?: (runId: string) => void;
  onEditNote?: (runId: string) => void;
  onAttachVideo?: (runId: string) => void;
  onPlayVideo?: (point: SeriesPoint, series: Series) => void;
}) {
  const points = useMemo(() => [...series.points].reverse(), [series.points]);

  return (
    <View style={styles.listCard}>
      <Text style={styles.listTitle} numberOfLines={1}>
        {seriesTitle(series).toUpperCase()} · {points.length} RUN{points.length === 1 ? '' : 'S'}
      </Text>

      {points.map((p) => {
        const open = p.runId === selectedRunId;
        return (
          <View key={p.runId}>
            <Pressable
              onPress={() => onSelectRun(open ? null : p.runId)}
              style={({ pressed }) => [styles.runRow, open && styles.runRowOn, pressed && styles.dim]}
              accessibilityRole="button"
              accessibilityState={{ selected: open }}
              accessibilityLabel={`${formatMs(p.elapsedMs)} seconds, ${listDate(p.createdAt)}${
                p.isBest ? ', personal best' : ''
              }`}
            >
              <Text style={[styles.runTime, p.isBest && styles.runTimeBest]}>
                {formatMs(p.elapsedMs)}s
              </Text>
              {p.isBest ? <Text style={styles.pb}>PB</Text> : null}
              {/* Visible without expanding: which runs have footage is the thing
                  you scan the list for once video exists. */}
              {p.clipId ? <Text style={styles.hasVideo}>▶</Text> : null}
              <View style={styles.runMid}>
                <Text style={styles.runDate}>{listDate(p.createdAt)}</Text>
                {/* The derived shape (a rep set's splits, a hand start) and the
                    coach's own words are different things and read as different
                    things — never concatenated into one ambiguous line. */}
                {p.note ? (
                  <Text style={styles.runMeta} numberOfLines={1}>
                    {p.note}
                  </Text>
                ) : null}
                {p.userNote ? (
                  <Text style={styles.runNote} numberOfLines={open ? 0 : 1}>
                    {p.userNote}
                  </Text>
                ) : null}
              </View>
            </Pressable>

            {open ? (
              <View style={styles.runActions}>
                {/* Play when there is footage, attach when there is not. Never
                    both — the run has one video or none, and offering "attach"
                    beside a clip invites silently replacing it. */}
                {p.clipId && onPlayVideo ? (
                  <Pressable
                    onPress={() => onPlayVideo(p, series)}
                    style={({ pressed }) => [styles.actionBtn, pressed && styles.dim]}
                  >
                    <Text style={[styles.actionText, styles.actionVideo]}>Play video</Text>
                  </Pressable>
                ) : null}
                {!p.clipId && onAttachVideo ? (
                  <Pressable
                    onPress={() => onAttachVideo(p.runId)}
                    style={({ pressed }) => [styles.actionBtn, pressed && styles.dim]}
                  >
                    <Text style={styles.actionText}>Attach video</Text>
                  </Pressable>
                ) : null}
                {onEditNote ? (
                  <Pressable
                    onPress={() => onEditNote(p.runId)}
                    style={({ pressed }) => [styles.actionBtn, pressed && styles.dim]}
                  >
                    <Text style={styles.actionText}>{p.userNote ? 'Edit note' : 'Add note'}</Text>
                  </Pressable>
                ) : null}
                {onDeleteRun ? (
                  <Pressable
                    onPress={() => onDeleteRun(p.runId)}
                    style={({ pressed }) => [styles.actionBtn, pressed && styles.dim]}
                  >
                    <Text style={[styles.actionText, styles.actionDanger]}>Delete run</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const listDate = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: '2-digit' });

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0e1116' },
  listCard: {
    backgroundColor: '#131a24',
    borderRadius: 12,
    paddingVertical: 6,
    marginTop: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#243042',
  },
  listTitle: {
    color: '#64748b',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.6,
    paddingHorizontal: 14,
    paddingTop: 6,
    paddingBottom: 8,
  },
  runRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    // 44 is the minimum comfortable tap target, and these are tapped with a thumb
    // at the side of a track.
    minHeight: 44,
    paddingVertical: 6,
  },
  runRowOn: { backgroundColor: '#1b2532' },
  runTime: {
    color: '#e2e8f0',
    fontSize: 15,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    minWidth: 58,
  },
  runTimeBest: { color: '#34d399' },
  pb: { color: '#34d399', fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
  runMid: { flex: 1, minWidth: 0 },
  runDate: { color: '#94a3b8', fontSize: 12 },
  runMeta: { color: '#64748b', fontSize: 11, marginTop: 1 },
  runNote: { color: '#cbd5e1', fontSize: 12, marginTop: 2, fontStyle: 'italic' },
  runActions: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 14,
    paddingBottom: 10,
    paddingTop: 2,
    backgroundColor: '#1b2532',
  },
  actionBtn: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    backgroundColor: '#243042',
  },
  actionText: { color: '#cbd5e1', fontSize: 13, fontWeight: '600' },
  actionDanger: { color: '#f87171' },
  actionVideo: { color: '#60a5fa' },
  hasVideo: { color: '#60a5fa', fontSize: 10 },
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
