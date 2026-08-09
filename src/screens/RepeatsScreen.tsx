// Single-gate timing, two flows that share nothing but a gate and a lockout.
//
// A SIBLING of DrillsScreen, not a mode inside it. L Drill and Shuttle Run are
// hardware-validated and share a save guard and a lockout persistence path; the
// cheapest way to not break them was to not edit that file at all.
//
// Both gates stay paired and connected. The engines ignore every frame from the
// gate they are not timing, so gate 2 being live costs nothing here.
//
//   CONTINUOUS  a set: laps accumulate, nothing is written until Save, and the
//               review list repairs a spurious crossing by JOINING the split into
//               its neighbour (the total never changes) rather than deleting time
//               the athlete really spent running.
//
//   REST        each rep is its OWN run. Tap to arm, the crossing closes it, it
//               saves immediately like any other run. No set, no mean, no review
//               list, no lap count — those existed to make sense of a chain, and
//               a rest rep is not one. The queue advances per rep and the DISCARD
//               WINDOW applies per rep, which is strictly better than a review
//               list: a bad rep is discardable on its own.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';

import { useGate } from '../ble/GateProvider';
import { useV2 } from '../ble/V2Provider';
import {
  HAND_START_ERROR_MS,
  REPEATS,
  REPEAT_LOCKOUT_BOUNDS,
  REPEAT_MODE,
  clampRepeatLockout,
  dropInterval,
  mergeCrossing,
  restRepRawJson,
  suspectIntervals,
  targetStatus,
  type RepSet,
  type RepeatConfig,
} from '../ble/repeats';
import { DRILL_MODE } from '../ble/drills';
import { resolveKey } from '../ble/catalog';
import { DiscardBar } from '../components/DiscardBar';
import { DrillPickerModal } from '../components/DrillPicker';
import { SetControl } from '../components/SetControl';
import { UpNextStrip } from '../components/UpNextStrip';
import { getSetting, saveRun, setSetting, type Drill } from '../db/database';
import { useRoster } from '../roster/RosterProvider';
import { usePendingRun } from '../runs/PendingRunProvider';

const KEEP_AWAKE_TAG = 'equalsplit-repeat';
const fmt = (ms: number, dec = 2) => (Math.max(0, ms) / 1000).toFixed(dec);
const lockoutKey = (key: string) => `repeat_lockout_${key}`;

/** @param selectedKey see DrillsScreen — same contract, same resolveKey fallback. */
export default function RepeatsScreen({
  selectedKey,
  header,
}: { selectedKey?: string; header?: React.ReactNode } = {}) {
  const gate = useGate();
  const v2 = useV2();
  const roster = useRoster();
  const pending = usePendingRun();

  const [ownKey, setOwnKey] = useState<string>(REPEATS[0].key);
  const variantKey = resolveKey(selectedKey, ownKey);
  const base = useMemo(() => REPEATS.find((r) => r.key === variantKey) ?? REPEATS[0], [variantKey]);
  const [lockoutMs, setLockoutMs] = useState<number>(base.lockoutMs);
  const config: RepeatConfig = useMemo(() => ({ ...base, lockoutMs }), [base, lockoutMs]);
  const isRest = base.variant === 'rest';

  /** CONTINUOUS only. A TARGET, never a terminal condition. 0 = none. */
  const [targetLaps, setTargetLaps] = useState(0);
  const [drill, setDrill] = useState<Drill | null>(null);
  const [drillOpen, setDrillOpen] = useState(false);
  /** CONTINUOUS only: the finished set under review. Local, so joining or ending
   *  early never reaches the provider (or the database) until Save. */
  const [review, setReview] = useState<RepSet | null>(null);
  const [dbg, setDbg] = useState('');
  const [saving, setSaving] = useState(false);
  const reviewedRef = useRef<RepSet | null>(null);
  const savedRepRef = useRef<unknown>(null);

  const live = isRest ? v2.restState !== 'idle' : v2.repeatState !== 'idle';
  const connected = gate.status === 'connected';

  // Refs so the rest-rep save effect reads whoever/whatever was current when the
  // crossing landed, without churning its dependencies.
  const athleteRef = useRef(roster.currentAthlete);
  athleteRef.current = roster.currentAthlete;
  const drillRef = useRef(drill);
  drillRef.current = drill;
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const rosterRef = useRef(roster);
  rosterRef.current = roster;

  // Persisted, tuned per variant.
  useEffect(() => {
    (async () => {
      try {
        const v = await getSetting(lockoutKey(base.key));
        const n = v == null ? base.lockoutMs : parseInt(v, 10);
        setLockoutMs(clampRepeatLockout(base.key, Number.isFinite(n) ? n : base.lockoutMs));
      } catch {
        setLockoutMs(base.lockoutMs);
      }
    })();
  }, [base]);

  // CONTINUOUS: hand a finished set to local review exactly once.
  useEffect(() => {
    const set = v2.lastRepSet;
    if (!set || reviewedRef.current === set) return;
    reviewedRef.current = set;
    setReview(set);
    v2.clearLastRepSet();
  }, [v2]);

  // REST: a closed rep IS a run. Save it immediately, like every other timing
  // screen — durability first, and the discard window is what un-does it.
  useEffect(() => {
    const rep = v2.lastRestRep;
    if (!rep || savedRepRef.current === rep) return;
    savedRepRef.current = rep;
    v2.clearLastRestRep();
    const who = athleteRef.current;
    const dr = drillRef.current;
    saveRun({
      // DRILL_MODE, not a mode of its own: one time from an app-parameterized
      // drill is a shape that already exists.
      mode: DRILL_MODE,
      totalMs: rep.ms,
      split1Ms: 0,
      split2Ms: 0,
      status: 'valid',
      athleteId: who?.id ?? null,
      drillId: dr?.id ?? null,
      // Carries startSource:'tap' and exact:false, so the accuracy fact lives on
      // the ROW and History and the chart both read it from one helper.
      rawJson: restRepRawJson(rep),
    })
      .then((runId) => {
        setDbg(`saved ${fmt(rep.ms)}s ✓ (hand-started)`);
        rosterRef.current.completeRun();
        pendingRef.current.offerRun({
          runId,
          totalMs: rep.ms,
          athleteName: who?.display_name ?? null,
          drillName: dr?.name ?? null,
          standalone: false,
          savedAt: Date.now(),
        });
      })
      .catch((e) => setDbg(`SAVE FAILED: ${String(e)}`));
  }, [v2]);

  useEffect(() => {
    if (live) activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    else deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
  }, [live]);

  const bumpLockout = useCallback(
    (delta: number) => {
      const b = REPEAT_LOCKOUT_BOUNDS[base.key];
      const next = clampRepeatLockout(base.key, lockoutMs + delta * (b?.stepMs ?? 100));
      setLockoutMs(next);
      setSetting(lockoutKey(base.key), String(next)).catch(() => {});
    },
    [base.key, lockoutMs],
  );

  const doArm = useCallback(() => {
    setReview(null);
    setDbg('');
    if (isRest) {
      // A new rep starting settles the previous rep's discard window.
      pending.settleForNextRep();
      v2.armRestRep(config);
    } else {
      v2.armRepeat(config, targetLaps || null);
    }
  }, [v2, config, targetLaps, isRest, pending]);

  const doSaveSet = useCallback(async () => {
    if (!review || saving) return;
    if (!review.intervals.length) {
      setReview(null);
      return;
    }
    setSaving(true);
    const who = roster.currentAthlete;
    try {
      await saveRun({
        mode: REPEAT_MODE,
        totalMs: review.totalMs,
        split1Ms: 0,
        split2Ms: 0,
        status: 'valid',
        athleteId: who?.id ?? null,
        drillId: drill?.id ?? null,
        rawJson: JSON.stringify({
          engine: 'repeat',
          variant: 'continuous',
          gateId: review.gateId,
          targetLaps: review.targetLaps,
          intervals: review.intervals.map((i) => i.ms),
          lockoutMs: review.lockoutMs,
          startSource: 'gate',
          exact: true,
        }),
      });
      setDbg(`saved ${review.intervals.length} lap(s) ✓`);
      setReview(null);
      roster.completeRun();
    } catch (e) {
      setDbg(`SAVE FAILED: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  }, [review, saving, roster, drill]);

  const liveIntervals = v2.repeatIntervals;
  const shown = review ?? null;
  const suspects = useMemo(() => (shown ? suspectIntervals(shown) : []), [shown]);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[styles.content, selectedKey != null && styles.contentEmbedded]}
    >
      {selectedKey == null ? (
        <View style={styles.setRow}>
          <SetControl />
        </View>
      ) : null}
      {header}

      <UpNextStrip />

      {/* REST reps are ordinary runs, so they get the ordinary post-run control. */}
      {isRest ? <DiscardBar /> : null}

      {selectedKey == null ? (
        <View style={styles.pickRow}>
          {REPEATS.map((r) => (
            <Pressable
              key={r.key}
              onPress={() => !live && setOwnKey(r.key)}
              disabled={live}
              style={({ pressed }) => [
                styles.pick,
                r.key === base.key && styles.pickOn,
                (live || pressed) && r.key !== base.key && styles.dim,
              ]}
            >
              <Text style={[styles.pickText, r.key === base.key && styles.pickTextOn]}>{r.title}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <Text style={styles.explain}>
        {isRest
          ? `Tap Start rep, athlete goes from standing, the crossing ends it and saves it as its own run. Rest is never timed. Hand-started — about ±${HAND_START_ERROR_MS}ms, not gate-accurate.`
          : 'First crossing starts the clock. Each crossing after it closes a lap. Gate-timed at both ends.'}
      </Text>

      <Pressable style={styles.tagBar} onPress={() => !live && setDrillOpen(true)} disabled={live}>
        <Text style={[styles.tagBarText, !drill && styles.tagBarPlaceholder]} numberOfLines={1}>
          {drill?.name || (isRest ? '＋  Drill (e.g. 400m)' : '＋  Drill (e.g. 1200m)')}
        </Text>
      </Pressable>

      {/* Lap target — CONTINUOUS only. A rest rep is one time; there is no chain
          to reconcile against a count. */}
      {!isRest ? (
        <>
          <View style={styles.lockRow}>
            <Text style={styles.lockLabel}>Laps</Text>
            <Pressable
              onPress={() => !live && setTargetLaps((n) => Math.max(0, n - 1))}
              disabled={live}
              style={({ pressed }) => [styles.step, (live || pressed) && styles.dim]}
            >
              <Text style={styles.stepText}>−</Text>
            </Pressable>
            <Text style={styles.lockValue}>{targetLaps || '—'}</Text>
            <Pressable
              onPress={() => !live && setTargetLaps((n) => Math.min(50, n + 1))}
              disabled={live}
              style={({ pressed }) => [styles.step, (live || pressed) && styles.dim]}
            >
              <Text style={styles.stepText}>＋</Text>
            </Pressable>
          </View>
          <Text style={styles.lockHint}>
            {targetLaps
              ? `Target only — the set will not stop itself at ${targetLaps}. Extra crossings get flagged for review.`
              : 'Optional. Set one to see live progress and have extra crossings flagged.'}
          </Text>
        </>
      ) : null}

      <View style={styles.lockRow}>
        <Text style={styles.lockLabel}>Lockout</Text>
        <Pressable
          onPress={() => bumpLockout(-1)}
          disabled={live}
          style={({ pressed }) => [styles.step, (live || pressed) && styles.dim]}
        >
          <Text style={styles.stepText}>−</Text>
        </Pressable>
        <Text style={styles.lockValue}>{fmt(lockoutMs, 1)}s</Text>
        <Pressable
          onPress={() => bumpLockout(1)}
          disabled={live}
          style={({ pressed }) => [styles.step, (live || pressed) && styles.dim]}
        >
          <Text style={styles.stepText}>＋</Text>
        </Pressable>
      </View>
      <Text style={styles.lockHint}>
        Ignores a second break within this window, so one crossing is one time.
        {isRest ? '' : ' Raise it if a walk-back through the beam registers as a lap.'}
      </Text>

      {live ? (
        <View style={styles.liveCard}>
          <Text style={styles.liveKicker}>
            {isRest
              ? 'REP RUNNING — CROSSING ENDS IT'
              : v2.repeatState === 'armed'
                ? 'WAITING FOR THE FIRST CROSSING'
                : 'RUNNING'}
          </Text>
          {!isRest ? (
            <>
              <Text style={styles.liveCount}>
                {targetLaps
                  ? `Lap ${Math.min(liveIntervals.length + 1, targetLaps)} of ${targetLaps}`
                  : `${liveIntervals.length} lap${liveIntervals.length === 1 ? '' : 's'}`}
              </Text>
              {targetLaps && liveIntervals.length > targetLaps ? (
                <Text style={styles.liveOver}>
                  {liveIntervals.length - targetLaps} past the target — still running, sort it at
                  the end
                </Text>
              ) : null}
              {liveIntervals.length ? (
                <Text style={styles.liveList} numberOfLines={2}>
                  {liveIntervals.map((i) => `${fmt(i.ms)}s`).join('  ·  ')}
                </Text>
              ) : null}
            </>
          ) : null}
        </View>
      ) : null}

      <View style={styles.actions}>
        {!live ? (
          <Pressable
            onPress={doArm}
            disabled={!connected}
            style={({ pressed }) => [styles.btn, styles.btnGo, (!connected || pressed) && styles.dim]}
          >
            <Text style={styles.btnText}>{isRest ? 'Start rep' : 'Start set'}</Text>
          </Pressable>
        ) : isRest ? (
          <Pressable
            onPress={v2.cancelRestRep}
            style={({ pressed }) => [styles.btn, pressed && styles.dim]}
          >
            <Text style={styles.btnTextMuted}>Cancel rep</Text>
          </Pressable>
        ) : (
          <>
            <Pressable
              onPress={v2.endRepeat}
              style={({ pressed }) => [styles.btn, styles.btnEnd, pressed && styles.dim]}
            >
              <Text style={styles.btnText}>End set</Text>
            </Pressable>
            <Pressable
              onPress={v2.cancelRepeat}
              style={({ pressed }) => [styles.btn, pressed && styles.dim]}
            >
              <Text style={styles.btnTextMuted}>Cancel</Text>
            </Pressable>
          </>
        )}
      </View>

      {/* CONTINUOUS review — the last moment before anything is written. */}
      {shown ? (
        <View style={styles.review}>
          <Text style={styles.reviewTitle}>
            {shown.intervals.length} lap{shown.intervals.length === 1 ? '' : 's'} · total{' '}
            <Text style={styles.reviewNum}>{fmt(shown.totalMs)}s</Text>
          </Text>
          <Text style={styles.reviewSub}>avg {fmt(shown.meanMs)}s</Text>

          {(() => {
            const st = targetStatus(shown);
            if (st.excess > 0) {
              return (
                <View style={styles.flagCard}>
                  <Text style={styles.flagText}>
                    {st.actual} recorded, {st.target} planned — join {st.excess} to match.
                    {suspects.length ? ' Marked ones look short enough to be walk-backs.' : ''}
                  </Text>
                </View>
              );
            }
            if (st.short > 0) {
              return (
                <View style={styles.flagCard}>
                  <Text style={styles.flagText}>
                    {st.actual} of {st.target} — saving anyway keeps what was run.
                  </Text>
                </View>
              );
            }
            return null;
          })()}

          <Text style={styles.repairHint}>
            Join removes a stray crossing and merges the split into its neighbour — the total never
            changes, only where the laps divide. “End here” is the exception: it discards the final
            split, ending the set at the previous crossing.
          </Text>

          {shown.intervals.map((it, i) => (
            <View
              key={`${it.closeUs}-${i}`}
              style={[styles.ivRow, suspects.includes(i) && styles.ivRowSuspect]}
            >
              <Text style={styles.ivIndex}>{i + 1}</Text>
              <Text style={styles.ivTime}>{fmt(it.ms)}s</Text>
              {suspects.includes(i) ? <Text style={styles.ivSuspect}>SHORT</Text> : null}
              <Pressable
                onPress={() => setReview(mergeCrossing(shown, i - 1))}
                disabled={i === 0}
                hitSlop={6}
                accessibilityLabel={`Join lap ${i + 1} into the one above`}
                style={({ pressed }) => [styles.ivMerge, (i === 0 || pressed) && styles.dim]}
              >
                <Text style={styles.ivMergeText}>⌃ join</Text>
              </Pressable>
              {i === shown.intervals.length - 1 ? (
                <Pressable
                  onPress={() => setReview(dropInterval(shown, i))}
                  hitSlop={6}
                  accessibilityLabel="Discard the final split, ending the set earlier"
                  style={({ pressed }) => [styles.ivDrop, pressed && styles.dim]}
                >
                  <Text style={styles.ivDropText}>end here</Text>
                </Pressable>
              ) : (
                <Pressable
                  onPress={() => setReview(mergeCrossing(shown, i))}
                  hitSlop={6}
                  accessibilityLabel={`Join lap ${i + 1} into the one below`}
                  style={({ pressed }) => [styles.ivMerge, pressed && styles.dim]}
                >
                  <Text style={styles.ivMergeText}>⌄ join</Text>
                </Pressable>
              )}
            </View>
          ))}

          <View style={styles.reviewActions}>
            <Pressable
              onPress={() => setReview(null)}
              style={({ pressed }) => [styles.btn, pressed && styles.dim]}
            >
              <Text style={styles.btnTextMuted}>Discard set</Text>
            </Pressable>
            <Pressable
              onPress={doSaveSet}
              disabled={saving || !shown.intervals.length}
              style={({ pressed }) => [
                styles.btn,
                styles.btnGo,
                (saving || !shown.intervals.length || pressed) && styles.dim,
              ]}
            >
              <Text style={styles.btnText}>Save set</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {dbg ? <Text style={styles.dbg}>{dbg}</Text> : null}

      <DrillPickerModal
        visible={drillOpen}
        currentId={drill?.id ?? null}
        title="Drill"
        onClose={() => setDrillOpen(false)}
        onPick={setDrill}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0e1116' },
  content: { paddingTop: 56, paddingHorizontal: 16, paddingBottom: 40 },
  contentEmbedded: { paddingTop: 6 },
  setRow: { marginBottom: 6 },
  pickRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  pick: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 11,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#243042',
  },
  pickOn: { backgroundColor: '#1e3a5f', borderColor: '#3b82f6' },
  pickText: { color: '#94a3b8', fontSize: 13, fontWeight: '700' },
  pickTextOn: { color: '#dbeafe' },
  explain: { color: '#64748b', fontSize: 11, lineHeight: 16, marginTop: 8 },
  tagBar: {
    backgroundColor: '#161b22',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginTop: 12,
    borderWidth: 1,
    borderColor: '#243042',
  },
  tagBarText: { color: '#e2e8f0', fontSize: 14, fontWeight: '600' },
  tagBarPlaceholder: { color: '#475569', fontWeight: '400' },
  lockRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14 },
  lockLabel: { color: '#94a3b8', fontSize: 13, fontWeight: '700', flex: 1 },
  step: {
    width: 44,
    height: 40,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#243042',
    backgroundColor: '#0b0e13',
  },
  stepText: { color: '#93c5fd', fontSize: 18, fontWeight: '800' },
  lockValue: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '800',
    minWidth: 54,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  lockHint: { color: '#475569', fontSize: 11, lineHeight: 16, marginTop: 6 },
  liveCard: {
    marginTop: 16,
    backgroundColor: '#12203a',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#1d4ed8',
  },
  liveKicker: { color: '#93c5fd', fontSize: 10, fontWeight: '800', letterSpacing: 0.8 },
  liveCount: { color: '#fff', fontSize: 24, fontWeight: '800', marginTop: 4 },
  liveOver: { color: '#fbbf24', fontSize: 11, marginTop: 4, lineHeight: 15 },
  liveList: { color: '#93c5fd', fontSize: 13, marginTop: 6, fontVariant: ['tabular-nums'] },
  actions: { flexDirection: 'row', gap: 10, marginTop: 16 },
  btn: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#243042',
    backgroundColor: '#161b22',
  },
  btnGo: { backgroundColor: '#1d4ed8', borderColor: '#1d4ed8' },
  btnEnd: { backgroundColor: '#b45309', borderColor: '#b45309' },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '800' },
  btnTextMuted: { color: '#94a3b8', fontSize: 15, fontWeight: '700' },
  review: {
    marginTop: 18,
    backgroundColor: '#161b22',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#243042',
  },
  reviewTitle: { color: '#cbd5e1', fontSize: 14, fontWeight: '700' },
  reviewNum: { color: '#fff', fontWeight: '800' },
  repairHint: { color: '#64748b', fontSize: 11, lineHeight: 16, marginBottom: 6 },
  reviewSub: { color: '#64748b', fontSize: 11, marginTop: 3, marginBottom: 8 },
  flagCard: {
    backgroundColor: '#2a1f10',
    borderColor: '#b45309',
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    marginTop: 8,
    marginBottom: 8,
  },
  flagText: { color: '#fbbf24', fontSize: 12, lineHeight: 17, fontWeight: '600' },
  ivRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 9,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#243042',
  },
  ivRowSuspect: { backgroundColor: '#2a1f10', borderRadius: 6 },
  ivIndex: { color: '#475569', fontSize: 12, fontWeight: '800', width: 18 },
  ivTime: { color: '#e2e8f0', fontSize: 16, fontWeight: '700', flex: 1, fontVariant: ['tabular-nums'] },
  ivSuspect: { color: '#fbbf24', fontSize: 10, fontWeight: '800' },
  ivMerge: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#243042',
  },
  ivMergeText: { color: '#93c5fd', fontSize: 11, fontWeight: '800' },
  ivDrop: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#7f1d1d',
  },
  ivDropText: { color: '#f87171', fontSize: 12, fontWeight: '700' },
  reviewActions: { flexDirection: 'row', gap: 10, marginTop: 14 },
  dbg: { color: '#64748b', fontSize: 12, marginTop: 12 },
  dim: { opacity: 0.45 },
});
