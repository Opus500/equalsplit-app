// Setting the date a run HAPPENED, and saying what that does before it does it.
//
// One module, two callers: the marking screen (before a run is saved) and the
// athlete run list (after). They ask the same question and must answer it the same
// way, and the last time a load-bearing rule lived in two copies here — the picker
// options — it was documented in one of them and nearly deleted from the other.
//
// THE WHEEL, not a text field. A system control cannot be laid out wrong, cannot be
// typed wrong, and cannot produce 2026-02-31; the text version needed a parser with
// a round-trip check to reject impossible dates, and that parser now only serves
// the tests that pin its rules. Bounded at both ends by the wheel itself, so
// "refused" is a date you cannot reach rather than an alert you read afterwards.
//
// THE GUARD IS THE CONSEQUENCE, NOT THE VALUE. Echoing "13 August 2025, is that
// right?" back at someone who just span a wheel to it catches nothing — they set
// what they meant to set, and the error is in what it DOES. The chart positions
// points by run ORDER, so a date does not slide a point sideways: it changes the
// run's RANK, and rank decides which run is firstMs and therefore the trend for the
// whole series.

import { useEffect, useState } from 'react';
import { Alert, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';

import { getAthleteRuns } from '../db/database';
import { formatDelta, sourceGroup, type TimeSource } from '../roster/progression';
import { seriesTimeSource } from '../video/timing';
import { MAX_BACKDATE_MS, dateImpact, effectiveRunDate, localNoon, sameLocalDay } from './rundate';

/**
 * Ask what a date would do to the series, then set it — or don't.
 *
 * `runId` present means an existing run is being MOVED; absent means a new one is
 * being placed. The difference is not cosmetic: a saved run is already in the
 * series, so it must not be compared against itself, and "before" has to mean the
 * chart as it looks today rather than a chart with the run deleted.
 */
export async function confirmRunDate({
  at,
  athleteId,
  drill,
  elapsedMs,
  timeSource,
  runId,
  currentAt,
  onConfirm,
}: {
  at: number;
  athleteId: string | null;
  drill: { id: string; name: string } | null;
  elapsedMs: number;
  /** How THIS run was timed — it decides which series it lands in. */
  timeSource: TimeSource;
  /** Set when re-dating a saved run. */
  runId?: string;
  /** That run's effective date today. Required with runId. */
  currentAt?: number;
  onConfirm: (at: number) => void;
}): Promise<void> {
  // A date in today is not backdating and gets no ceremony.
  if (sameLocalDay(at, Date.now()) && !runId) {
    onConfirm(at);
    return;
  }
  if (!athleteId || !drill) {
    // No series to disturb, so nothing to warn about. An untagged run is charted
    // nowhere and its date changes nothing but its own row.
    onConfirm(at);
    return;
  }

  const group = sourceGroup(timeSource);
  let others: { elapsedMs: number; at: number }[] = [];
  try {
    const rows = await getAthleteRuns(athleteId);
    others = rows
      .filter(
        (r) =>
          r.status === 'valid' &&
          r.id !== runId &&
          r.drill_id === drill.id &&
          // THE SERIES IT WOULD JOIN, under the current grouping rule. This read
          // 'video' literally until gate and video were merged, which quietly made
          // the warning describe a chart with a third of the runs on it.
          sourceGroup(seriesTimeSource(r.raw_json)) === group,
      )
      .map((r) => ({ elapsedMs: r.total_ms, at: effectiveRunDate(r.performed_at, r.created_at) }));
  } catch {
    // A failed lookup must not block the edit; it only costs the warning.
    others = [];
  }

  const impact = dateImpact(
    others,
    { elapsedMs: Math.round(elapsedMs), at },
    runId && currentAt !== undefined ? { at: currentAt } : undefined,
  );
  if (!impact.reorders) {
    onConfirm(at);
    return;
  }

  // WHAT IT DOES, in the order it matters: where the run lands, then what the
  // drill's trend becomes. The trend line is omitted when it does not move, because
  // a warning that always says the same thing stops being read.
  const lines = [
    impact.becomesEarliest
      ? `This becomes the EARLIEST of ${impact.total} ${drill.name} runs.`
      : `This lands ${impact.rank} of ${impact.total} ${drill.name} runs, not last.`,
  ];
  if (
    impact.deltaBeforeMs !== null &&
    impact.deltaAfterMs !== null &&
    formatDelta(impact.deltaBeforeMs) !== formatDelta(impact.deltaAfterMs)
  ) {
    lines.push(
      `The trend for this drill changes from ${formatDelta(impact.deltaBeforeMs)} to ` +
        `${formatDelta(impact.deltaAfterMs)}.`,
    );
  }
  lines.push('The chart orders runs by sequence, so a wrong year reshapes the whole series.');

  Alert.alert(`Date it ${longDate(at)}?`, lines.join('\n\n'), [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Use this date', onPress: () => onConfirm(at) },
  ]);
}

export const longDate = (at: number) =>
  new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

/**
 * The wheel, in a sheet with an explicit Set.
 *
 * NOT the bare inline picker. On iOS a spinner reports every value the wheel passes
 * through as the finger moves, so committing on change would file the run under
 * whatever date happened to be under the thumb mid-spin — and would fire the
 * consequence warning several times on the way. The sheet makes "I have chosen"
 * a separate act from "I am choosing".
 */
export function RunDateModal({
  visible,
  value,
  title,
  onCancel,
  onPick,
}: {
  visible: boolean;
  /** The date to open on. */
  value: number;
  title?: string;
  onCancel: () => void;
  onPick: (at: number) => void;
}) {
  const [draft, setDraft] = useState(value);

  // Re-seed each time it opens. Without this the wheel keeps the last session's
  // value, so opening it on a second run shows the first run's date.
  useEffect(() => {
    if (visible) setDraft(value);
  }, [visible, value]);

  const now = Date.now();

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onCancel}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>{title ?? 'When did this run happen?'}</Text>
          <Text style={styles.sub}>
            The date the run happened, not the date you are recording it.
          </Text>

          {Platform.OS === 'ios' ? (
            <DateTimePicker
              value={new Date(draft)}
              mode="date"
              display="spinner"
              themeVariant="dark"
              // BOUNDED BY THE CONTROL. A future date is not a run that happened and
              // five years back is a year typo; making them unreachable on the wheel
              // is better than refusing them in an alert after the fact.
              maximumDate={new Date(now)}
              minimumDate={new Date(now - MAX_BACKDATE_MS)}
              onChange={(_e, d) => {
                // Local NOON, so no timezone or DST shift can move the day. The wheel
                // hands back midnight in the device's zone; storing that leaves a
                // date one hour from rolling backwards over a DST boundary.
                if (d) setDraft(localNoon(d.getTime()));
              }}
              style={styles.wheel}
            />
          ) : (
            <Text style={styles.sub}>The date wheel is iOS-only for now.</Text>
          )}

          <View style={styles.row}>
            <Pressable
              onPress={onCancel}
              style={({ pressed }) => [styles.btn, pressed && styles.dim]}
            >
              <Text style={styles.btnText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={() => onPick(draft)}
              style={({ pressed }) => [styles.btn, styles.btnPrimary, pressed && styles.dim]}
            >
              <Text style={[styles.btnText, styles.btnPrimaryText]}>Set date</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#000a', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#161b22',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 18,
    paddingBottom: 34,
    gap: 4,
  },
  title: { color: '#fff', fontSize: 17, fontWeight: '800' },
  sub: { color: '#94a3b8', fontSize: 12.5, lineHeight: 18 },
  wheel: { alignSelf: 'stretch' },
  row: { flexDirection: 'row', gap: 10, marginTop: 6 },
  btn: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#243042',
    backgroundColor: '#0b0e13',
  },
  btnPrimary: { backgroundColor: '#1d4ed8', borderColor: '#1d4ed8' },
  btnText: { color: '#cbd5e1', fontSize: 15, fontWeight: '700' },
  btnPrimaryText: { color: '#fff' },
  dim: { opacity: 0.6 },
});
