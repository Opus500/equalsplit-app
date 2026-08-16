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

import {
  deleteRun,
  getAthleteRuns,
  setRunClip,
  setRunNote,
  updateRunDrill,
  type Athlete,
  type AthleteRunRow,
  type Drill,
} from '../db/database';
import { DrillPickerModal } from './DrillPicker';
import {
  CAMERA_ROLL_DENIED_MESSAGE,
  CAMERA_ROLL_DENIED_TITLE,
  deleteClip,
  exportClipToCameraRoll,
  formatBytes,
  getClip,
  importClip,
  shareClip,
  PHOTO_ACCESS_MESSAGE,
  PHOTO_ACCESS_TITLE,
  pickVideo,
} from '../video/clips';
import { acceptForReview, seriesTimeSource } from '../video/timing';
import { effectiveRunDate, isBackdated } from '../runs/rundate';
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
            // THE EFFECTIVE date — what the coach said, else when it was written.
            // One helper so the chart, this list and History cannot disagree.
            createdAt: effectiveRunDate(r.performed_at, r.created_at),
            backdated: isBackdated(r.performed_at, r.created_at),
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

  // EVERY series reaches the pager, chartable or not.
  //
  // Thin ones used to be filtered out here and rendered as a summary card with no
  // run list, which made their runs unreachable from this screen — no play, no
  // note, no delete, for the runs most likely to need attention. The chart needs a
  // minimum because a line through one point is not a trend; the LIST does not,
  // because a single run is still a real run. Each page now suppresses its own
  // graph and keeps everything else.
  //
  // Sorted graphable-first by buildProgression, so the pager still opens on
  // something worth looking at.
  const allSeries = prog?.series ?? [];

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
          'Deleted everywhere, including History. This cannot be undone.' +
          // Said, not done. Deleting the footage along with the run would destroy
          // the very thing a coach might be keeping — but leaving it unmentioned
          // is how megabytes accumulate with nothing pointing at them.
          (row.clip_id ? '\n\nIts video is KEPT, and stays listed under Videos.' : ''),
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
  const [attaching, setAttaching] = useState<string | null>(null);
  /**
   * Guards against a second attach starting while the first is still copying.
   *
   * A ref, not the state above: the state is for the label, and a handler reading
   * it from a closure would see whatever it was when that closure was made — the
   * exact stale-closure shape that has already produced three bugs in this
   * feature. Two attaches racing would import twice and orphan the loser, since
   * the second setRunClip simply overwrites the first.
   */
  const attachBusy = useRef(false);

  const attachVideo = useCallback(
    async (runId: string) => {
      if (attachBusy.current) return;
      attachBusy.current = true;
      setAttaching(runId);
      try {
        // Same pickVideo() the marking screen calls. Its Passthrough and
        // shouldDownloadFromNetwork options are what stop a silent re-encode and
        // PHPhotosError 3164, and they used to be a verbatim copy here with the
        // reasoning recorded only in the other file.
        const picked = await pickVideo();
        if (picked.status === 'denied') {
          Alert.alert(PHOTO_ACCESS_TITLE, PHOTO_ACCESS_MESSAGE);
          return;
        }
        if (picked.status !== 'picked') return;
        // WARNED, not refused. Nothing computes a time from attached footage, and
        // watching a sprint in slow motion is the reason you film it that way —
        // refusing it here would remove a real use for no safety gain. The marking
        // screen is where the refusal belongs, and it has one.
        const verdict = acceptForReview(picked.timeScale);
        const imported = await importClip(picked.uri);
        // ORDER MATTERS on a replace. The new clip is imported and the reference
        // moved BEFORE the old file is deleted, so a cancelled pick or a failed
        // import leaves the existing video exactly where it was. Deleting first
        // would mean an out-of-space import destroyed the footage it was replacing.
        const previous = rows?.find((r) => r.id === runId)?.clip_id ?? null;
        await setRunClip(runId, imported.id);
        setRows((prev) => prev?.map((r) => (r.id === runId ? { ...r, clip_id: imported.id } : r)) ?? null);
        if (previous && previous !== imported.id) deleteClip(previous);
        if (verdict.accept && verdict.warn) Alert.alert('Attached', verdict.warn);
      } catch (e) {
        Alert.alert('Could not attach that video', String(e));
      } finally {
        attachBusy.current = false;
        setAttaching(null);
      }
    },
    [rows],
  );

  /**
   * Swap the video on a run that already has one.
   *
   * Confirmed first, because the old footage is destroyed once the new clip lands
   * and there is no undo. Play and Attach were made mutually exclusive precisely so
   * a replacement could never happen silently — this is that same rule with the
   * deliberate path added rather than removed.
   */
  const replaceVideo = useCallback(
    (runId: string) => {
      Alert.alert(
        'Replace this video?',
        'You pick a new clip, and the current one is deleted once it lands. The run and its time are unaffected.\n\n' +
          'If you cancel the picker or the import fails, nothing changes.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Choose a video', onPress: () => void attachVideo(runId) },
        ],
      );
    },
    [attachVideo],
  );

  /**
   * Take the video off a run and reclaim the space.
   *
   * Deletes the file rather than only clearing the reference. A detached clip is
   * exactly what the library labels "NO RUN — SAFE TO DELETE", so leaving it would
   * mean the coach had to do this twice to get the outcome they asked for. The
   * confirm says both halves out loud, and the run's time is never touched.
   */
  const removeVideo = useCallback(
    (runId: string) => {
      const clipId = rows?.find((r) => r.id === runId)?.clip_id ?? null;
      if (!clipId) return;
      const size = getClip(clipId)?.bytes ?? 0;
      Alert.alert(
        'Remove this video?',
        `The video file is deleted${size ? ` and ${formatBytes(size)} freed` : ''}. ` +
          'The run and its time are kept.\n\nThis cannot be undone.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Remove video',
            style: 'destructive',
            onPress: async () => {
              try {
                await setRunClip(runId, null);
                setRows((prev) => prev?.map((r) => (r.id === runId ? { ...r, clip_id: null } : r)) ?? null);
                deleteClip(clipId);
              } catch (e) {
                Alert.alert('Could not remove that video', String(e));
              }
            },
          },
        ],
      );
    },
    [rows],
  );

  /**
   * Hand this run's video to the share sheet.
   *
   * Sharing was reachable only from the Videos pane, which meant finding the clip
   * in a list of clips to share a run you were already looking at. Same helper the
   * library calls.
   */
  /** Save this run's video into the camera roll. Same helper the library calls. */
  const exportVideo = useCallback(async (runId: string) => {
    const clipId = rows?.find((r) => r.id === runId)?.clip_id ?? null;
    try {
      const r = await exportClipToCameraRoll(clipId);
      if (r === 'denied') Alert.alert(CAMERA_ROLL_DENIED_TITLE, CAMERA_ROLL_DENIED_MESSAGE);
      else if (r === 'missing') Alert.alert('Video deleted', 'There is nothing left to save.');
      else Alert.alert('Saved', 'The video is in your camera roll. It stays in the app too.');
    } catch (e) {
      Alert.alert('Could not save', String(e));
    }
  }, [rows]);

  const shareVideo = useCallback(async (runId: string) => {
    const clipId = rows?.find((r) => r.id === runId)?.clip_id ?? null;
    try {
      if (!(await shareClip(clipId))) {
        Alert.alert('Video deleted', "This run's video was removed, so there is nothing to share.");
      }
    } catch (e) {
      Alert.alert('Could not share', String(e));
    }
  }, [rows]);

  const [playing, setPlaying] = useState<{ clipId: string; title: string; sub: string } | null>(null);
  const [assigning, setAssigning] = useState<string | null>(null);

  /**
   * Give a drill to a run that had none.
   *
   * `rows` is updated locally as well as in the database, and that is what makes
   * the run MOVE without reopening the sheet: `prog` is a useMemo over `rows`, so
   * a changed drill_id re-runs buildProgression, the run leaves `unlabeled` and
   * joins that drill's series, and the pager re-renders around it. Reloading from
   * SQLite would work too but would blink the whole screen.
   */
  const assignDrill = useCallback(
    async (runId: string, drill: Drill | null) => {
      try {
        await updateRunDrill(runId, drill?.id ?? null);
        setRows(
          (prev) =>
            prev?.map((r) =>
              r.id === runId ? { ...r, drill_id: drill?.id ?? null, drill_name: drill?.name ?? null } : r,
            ) ?? null,
        );
      } catch (e) {
        Alert.alert('Could not assign that drill', String(e));
      }
    },
    [],
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
              <ChartPager
                series={allSeries}
                unlabeled={prog?.unlabeled ?? []}
                onAssignDrill={setAssigning}
                onDeleteRun={confirmDeleteRun}
                onEditNote={editNote}
                onAttachVideo={(id) => void attachVideo(id)}
                onShareVideo={(id) => void shareVideo(id)}
                onExportVideo={(id) => void exportVideo(id)}
                onReplaceVideo={replaceVideo}
                onRemoveVideo={removeVideo}
                attachingRunId={attaching}
                onPlayVideo={(p, pageTitle) =>
                  setPlaying({
                    clipId: p.clipId!,
                    title: `${formatMs(p.elapsedMs)}s · ${pageTitle}`,
                    sub: `${athlete?.display_name ?? ''} · ${new Date(p.createdAt).toLocaleDateString()}`,
                  })
                }
                selectedRunId={selectedRunId}
                onSelectRun={setSelectedRunId}
              />

              {/* The separate "not enough data yet" card is gone. It duplicated
                  series the pager now carries, and it was the thing standing in
                  for their runs while making those runs unreachable. Each page
                  states its own shortfall where the graph would have been. */}

              {!allSeries.length ? (
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
        <DrillPickerModal
          visible={!!assigning}
          currentId={null}
          kind="all"
          title="Which drill was this?"
          onClose={() => setAssigning(null)}
          onPick={(d) => {
            const runId = assigning;
            setAssigning(null);
            if (runId) void assignDrill(runId, d);
          }}
        />

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
  unlabeled = [],
  onDeleteRun,
  onEditNote,
  onAttachVideo,
  onShareVideo,
  onExportVideo,
  onReplaceVideo,
  onRemoveVideo,
  attachingRunId,
  onPlayVideo,
  onAssignDrill,
  selectedRunId,
  onSelectRun,
}: {
  series: Series[];
  /** Runs with no drill. APPENDED as the final page rather than sorted into the
   *  list — it is not a series and cannot compete for position, so "last" is a
   *  property of the structure instead of a rule that could be re-sorted away. */
  unlabeled?: SeriesPoint[];
  onDeleteRun?: (runId: string) => void;
  onEditNote?: (runId: string) => void;
  onAttachVideo?: (runId: string) => void;
  onShareVideo?: (runId: string) => void;
  onExportVideo?: (runId: string) => void;
  onReplaceVideo?: (runId: string) => void;
  onRemoveVideo?: (runId: string) => void;
  /** Which run is mid-import, so the button can say so. Copying a clip is a file
   *  copy of tens of megabytes and a silent button reads as a dead one. */
  attachingRunId?: string | null;
  onPlayVideo?: (point: SeriesPoint, title: string) => void;
  onAssignDrill?: (runId: string) => void;
  selectedRunId: string | null;
  onSelectRun: (runId: string | null) => void;
}) {
  const [pageW, setPageW] = useState(0);
  const [page, setPage] = useState(0);
  const ref = useRef<ScrollView>(null);

  // Pages = one per series, plus ONE appended for runs with no drill.
  //
  // Appended, not sorted in. It is not a Series and never competes for position,
  // so "sorts last" is a property of the structure rather than a comparator that
  // a later change could reorder.
  const hasUnlabeled = unlabeled.length > 0;
  const pageCount = series.length + (hasUnlabeled ? 1 : 0);

  // Archiving a drill's runs (or a filter change) can shorten the list under us;
  // without this the pager would sit on a page that no longer exists.
  //
  // Clamped to pageCount, NOT to series.length. Against series.length the
  // unlabelled page was structurally unreachable: swiping onto it set page to
  // series.length, this effect immediately pulled it back to series.length - 1,
  // and the run list underneath went on describing the previous drill while the
  // card above it said "No drill". The bug only appeared when there was at least
  // one real series, which is why the all-untagged athlete looked fine.
  useEffect(() => {
    if (page > pageCount - 1) setPage(Math.max(0, pageCount - 1));
  }, [pageCount, page]);

  const onLayout = (e: LayoutChangeEvent) => setPageW(e.nativeEvent.layout.width);

  /**
   * Which page is on screen, tracked DURING the scroll.
   *
   * The run list is rendered from this, and it used to update only in
   * onMomentumScrollEnd — which fires when the deceleration has completely
   * finished, not when the new page arrives. So the chart slid into place and the
   * list underneath sat on the old series until the scroll physics ran out, then
   * swapped. That pause is the "old list disappears, new one appears after a beat"
   * — nothing was slow, the list was simply told late.
   *
   * Guarded on a CHANGE of page rather than setting state on every scroll event,
   * so a swipe costs one re-render rather than sixty.
   */
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!pageW) return;
    const next = Math.round(e.nativeEvent.contentOffset.x / pageW);
    setPage((cur) => (next !== cur && next >= 0 ? next : cur));
  };

  const goTo = (i: number) => {
    setPage(i);
    ref.current?.scrollTo({ x: i * pageW, animated: true });
  };

  if (!pageCount) return null;

  const idx = Math.min(page, pageCount - 1);
  const onUnlabeled = hasUnlabeled && idx === series.length;
  const current = onUnlabeled ? null : series[idx];

  // The list always describes the page currently on screen.
  const runList = onUnlabeled ? (
    <RunList
      title="No drill"
      points={unlabeled}
      newestFirst={false}
      selectedRunId={selectedRunId}
      onSelectRun={onSelectRun}
      onDeleteRun={onDeleteRun}
      onEditNote={onEditNote}
      onAttachVideo={onAttachVideo}
      onShareVideo={onShareVideo}
      onExportVideo={onExportVideo}
      onReplaceVideo={onReplaceVideo}
      onRemoveVideo={onRemoveVideo}
      attachingRunId={attachingRunId}
      onPlayVideo={onPlayVideo}
      onAssignDrill={onAssignDrill}
    />
  ) : current ? (
    <RunList
      title={seriesTitle(current)}
      points={current.points}
      selectedRunId={selectedRunId}
      onSelectRun={onSelectRun}
      onDeleteRun={onDeleteRun}
      onEditNote={onEditNote}
      onAttachVideo={onAttachVideo}
      onShareVideo={onShareVideo}
      onExportVideo={onExportVideo}
      onReplaceVideo={onReplaceVideo}
      onRemoveVideo={onRemoveVideo}
      attachingRunId={attachingRunId}
      onPlayVideo={onPlayVideo}
    />
  ) : null;

  return (
    <View onLayout={onLayout}>
      {pageW > 0 ? (
        <>
          <ScrollView
            ref={ref}
            horizontal
            pagingEnabled
            scrollEnabled={pageCount > 1}
            showsHorizontalScrollIndicator={false}
            onScroll={onScroll}
            // 16ms ~ once per frame. The handler bails unless the page actually
            // changed, so this is a cheap comparison sixty times a second, not
            // sixty re-renders.
            scrollEventThrottle={16}
            onMomentumScrollEnd={onScroll}
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
            {hasUnlabeled ? (
              <View key="__unlabeled" style={{ width: pageW }}>
                <UnlabeledCard count={unlabeled.length} />
              </View>
            ) : null}
          </ScrollView>

          {pageCount > 1 ? (
            <View style={styles.dots}>
              {series.map((s, i) => (
                <Pressable
                  key={seriesUid(s)}
                  onPress={() => goTo(i)}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel={`Show ${s.drillName} chart, ${i + 1} of ${pageCount}`}
                  style={styles.dotHit}
                >
                  <View style={[styles.dot, i === idx && styles.dotOn]} />
                </Pressable>
              ))}
              {hasUnlabeled ? (
                <Pressable
                  key="__unlabeled"
                  onPress={() => goTo(series.length)}
                  hitSlop={10}
                  accessibilityRole="button"
                  accessibilityLabel={`Show runs with no drill, ${pageCount} of ${pageCount}`}
                  style={styles.dotHit}
                >
                  <View style={[styles.dot, onUnlabeled && styles.dotOn]} />
                </Pressable>
              ) : null}
              <Text style={styles.pagerLabel}>
                {idx + 1} / {pageCount}
              </Text>
            </View>
          ) : null}

          {runList}
        </>
      ) : null}
    </View>
  );
}

/**
 * The page for runs with no drill.
 *
 * Its chart is suppressed PERMANENTLY, not pending a threshold, and it says so.
 * No number of untagged runs makes this chartable: they are different distances
 * sharing nothing but the absence of a label, and a trend line across them would
 * be the exact claim the grouping rule exists to prevent. Telling the coach
 * "N more runs and a trend appears" here would be a promise that can never be
 * kept.
 */
function UnlabeledCard({ count }: { count: number }) {
  return (
    <View style={styles.unlabeledCard}>
      <Text style={styles.unlabeledTitle}>No drill</Text>
      <Text style={styles.unlabeledBody}>
        {count} run{count === 1 ? '' : 's'} saved without a drill. These are never charted at any
        count — different distances share nothing but the missing label, and a line across them would
        mean nothing.
      </Text>
      <Text style={styles.unlabeledHint}>Assign a drill to a run and it joins that drill's chart.</Text>
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
  title,
  points: given,
  newestFirst = true,
  selectedRunId,
  onSelectRun,
  onDeleteRun,
  onEditNote,
  onAttachVideo,
  onShareVideo,
  onExportVideo,
  onReplaceVideo,
  onRemoveVideo,
  attachingRunId,
  onPlayVideo,
  onAssignDrill,
}: {
  title: string;
  points: SeriesPoint[];
  /** Series points arrive oldest-first (chart order); the unlabelled list is
   *  already newest-first and must not be reversed again. */
  newestFirst?: boolean;
  selectedRunId: string | null;
  onSelectRun: (runId: string | null) => void;
  onDeleteRun?: (runId: string) => void;
  onEditNote?: (runId: string) => void;
  onAttachVideo?: (runId: string) => void;
  onShareVideo?: (runId: string) => void;
  onExportVideo?: (runId: string) => void;
  onReplaceVideo?: (runId: string) => void;
  onRemoveVideo?: (runId: string) => void;
  /** see ChartPager */
  attachingRunId?: string | null;
  onPlayVideo?: (point: SeriesPoint, title: string) => void;
  /** Only offered where it is the obvious next action: a run with no drill. */
  onAssignDrill?: (runId: string) => void;
}) {
  const points = useMemo(
    () => (newestFirst ? [...given].reverse() : given),
    [given, newestFirst],
  );

  return (
    <View style={styles.listCard}>
      <Text style={styles.listTitle} numberOfLines={1}>
        {title.toUpperCase()} · {points.length} RUN{points.length === 1 ? '' : 'S'}
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
              {/* A backdated run reshapes the series it joins, so the marker sits
                  in the list next to the time rather than inside the expanded
                  row: a strange-looking chart has to be explainable at a glance. */}
              {p.backdated ? <Text style={styles.backdated}>BACKDATED</Text> : null}
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
                {onAssignDrill ? (
                  <Pressable
                    onPress={() => onAssignDrill(p.runId)}
                    style={({ pressed }) => [styles.actionBtn, pressed && styles.dim]}
                  >
                    <Text style={[styles.actionText, styles.actionVideo]}>Assign drill</Text>
                  </Pressable>
                ) : null}
                {p.clipId && onPlayVideo ? (
                  <Pressable
                    onPress={() => onPlayVideo(p, title)}
                    style={({ pressed }) => [styles.actionBtn, pressed && styles.dim]}
                  >
                    <Text style={[styles.actionText, styles.actionVideo]}>Play video</Text>
                  </Pressable>
                ) : null}
                {/* Both named, both confirmed. Attach stays absent while a clip is
                    present — that rule was right and is unchanged — but "no silent
                    replacement" was never meant to mean "no replacement", and a
                    clip you attached to the wrong run had no way off it. */}
                {p.clipId && onShareVideo ? (
                  <Pressable
                    onPress={() => onShareVideo(p.runId)}
                    style={({ pressed }) => [styles.actionBtn, pressed && styles.dim]}
                  >
                    <Text style={styles.actionText}>Share</Text>
                  </Pressable>
                ) : null}
                {p.clipId && onExportVideo ? (
                  <Pressable
                    onPress={() => onExportVideo(p.runId)}
                    style={({ pressed }) => [styles.actionBtn, pressed && styles.dim]}
                  >
                    <Text style={styles.actionText}>Camera roll</Text>
                  </Pressable>
                ) : null}
                {p.clipId && onReplaceVideo ? (
                  <Pressable
                    onPress={() => onReplaceVideo(p.runId)}
                    disabled={!!attachingRunId}
                    style={({ pressed }) => [
                      styles.actionBtn,
                      (pressed || !!attachingRunId) && styles.dim,
                    ]}
                  >
                    <Text style={styles.actionText}>
                      {attachingRunId === p.runId ? 'Copying…' : 'Replace video'}
                    </Text>
                  </Pressable>
                ) : null}
                {p.clipId && onRemoveVideo ? (
                  <Pressable
                    onPress={() => onRemoveVideo(p.runId)}
                    style={({ pressed }) => [styles.actionBtn, pressed && styles.dim]}
                  >
                    <Text style={[styles.actionText, styles.actionDanger]}>Remove video</Text>
                  </Pressable>
                ) : null}
                {!p.clipId && onAttachVideo ? (
                  <Pressable
                    onPress={() => onAttachVideo(p.runId)}
                    disabled={!!attachingRunId}
                    style={({ pressed }) => [
                      styles.actionBtn,
                      (pressed || !!attachingRunId) && styles.dim,
                    ]}
                  >
                    <Text style={styles.actionText}>
                      {attachingRunId === p.runId ? 'Copying…' : 'Attach video'}
                    </Text>
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
    // WRAPS. A run with a video now offers Play, Replace, Remove, Share, Add note
    // and Delete — six controls that do not fit a phone's width, and without this
    // the last two were simply off the edge of the screen with nothing to suggest
    // they existed. Wrapping rather than scrolling horizontally: a hidden action
    // is worse than a taller row, and the row only appears on the selected run.
    flexWrap: 'wrap',
    rowGap: 8,
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
  backdated: { color: '#fbbf24', fontSize: 8.5, fontWeight: '800', letterSpacing: 0.4 },
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
  unlabeledCard: {
    backgroundColor: '#12151b',
    borderRadius: 14,
    padding: 18,
    gap: 8,
    borderWidth: 1,
    borderColor: '#243042',
    // Roughly a chart's height, so this page is not a different size from its
    // neighbours as the pager swipes past it.
    minHeight: 232,
    justifyContent: 'center',
  },
  unlabeledTitle: { color: '#e2e8f0', fontSize: 16, fontWeight: '800' },
  unlabeledBody: { color: '#94a3b8', fontSize: 13, lineHeight: 19 },
  unlabeledHint: { color: '#60a5fa', fontSize: 12, fontWeight: '600' },
  footnote: { color: '#475569', fontSize: 11, lineHeight: 16, marginTop: 14 },
  dim: { opacity: 0.5 },
});
