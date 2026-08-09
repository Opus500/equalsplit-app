// Rep sets: single-gate interval timing (src/ble/repeats.ts).
//
// A SIBLING of DrillsScreen, not a mode inside it. L Drill and Shuttle Run are
// hardware-validated and share a save guard and a lockout persistence path; the
// cheapest way to not break them was to not edit that file at all.
//
// Both gates stay paired and connected. The engine ignores every frame from the
// gate it is not timing, so gate 2 being live costs nothing here.
//
// NOTHING is written until Save. The end-of-set list is the review step — and it
// is also the discard affordance, which is why rep sets do not open the post-run
// discard window: you already saw every interval before it was stored.

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
  chartValueMs,
  clampRepeatLockout,
  dropInterval,
  type RepSet,
  type RepeatConfig,
} from '../ble/repeats';
import { DrillPickerModal } from '../components/DrillPicker';
import { SetControl } from '../components/SetControl';
import { UpNextStrip } from '../components/UpNextStrip';
import { getSetting, saveRun, setSetting, type Drill } from '../db/database';
import { useRoster } from '../roster/RosterProvider';

const KEEP_AWAKE_TAG = 'equalsplit-repeat';
const fmt = (ms: number, dec = 2) => (Math.max(0, ms) / 1000).toFixed(dec);
const lockoutKey = (key: string) => `repeat_lockout_${key}`;

export default function RepeatsScreen() {
  const gate = useGate();
  const v2 = useV2();
  const roster = useRoster();

  const [variantKey, setVariantKey] = useState<string>(REPEATS[0].key);
  const base = useMemo(() => REPEATS.find((r) => r.key === variantKey) ?? REPEATS[0], [variantKey]);
  const [lockoutMs, setLockoutMs] = useState<number>(base.lockoutMs);
  const config: RepeatConfig = useMemo(() => ({ ...base, lockoutMs }), [base, lockoutMs]);

  const [drill, setDrill] = useState<Drill | null>(null);
  const [drillOpen, setDrillOpen] = useState(false);
  // The finished set being reviewed. Local, so dropping an interval never
  // reaches the provider (or the database) until Save.
  const [review, setReview] = useState<RepSet | null>(null);
  const [dbg, setDbg] = useState('');
  const [saving, setSaving] = useState(false);
  const reviewedRef = useRef<RepSet | null>(null);

  const idle = v2.repeatState === 'idle';
  const live = !idle;
  const connected = gate.status === 'connected';

  // Load the tuned lockout for this variant (persisted, per variant key).
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

  // Hand a finished set to the local review state exactly once.
  useEffect(() => {
    const set = v2.lastRepSet;
    if (!set || reviewedRef.current === set) return;
    reviewedRef.current = set;
    setReview(set);
    v2.clearLastRepSet();
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
    v2.armRepeat(config);
  }, [v2, config]);

  const doSave = useCallback(async () => {
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
        // The honest sum. chartValueMs decides what the GRAPH plots — total for
        // continuous, mean for rest — from this plus the variant in raw_json.
        totalMs: review.totalMs,
        split1Ms: 0,
        split2Ms: 0,
        status: 'valid',
        athleteId: who?.id ?? null,
        drillId: drill?.id ?? null,
        rawJson: JSON.stringify({
          engine: 'repeat',
          variant: review.variant,
          gateId: review.gateId,
          intervals: review.intervals.map((i) => i.ms),
          startSources: review.intervals.map((i) => i.startSource),
          lockoutMs: review.lockoutMs,
          exact: review.exact,
        }),
      });
      setDbg(`saved ${review.intervals.length} interval(s) ✓`);
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

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.setRow}>
        <SetControl />
      </View>

      <UpNextStrip />

      {/* Variant picker — locked while a set is live, because switching mid-set
          would make the intervals already collected mean something else. */}
      <View style={styles.pickRow}>
        {REPEATS.map((r) => (
          <Pressable
            key={r.key}
            onPress={() => !live && setVariantKey(r.key)}
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

      <Text style={styles.explain}>
        {base.variant === 'continuous'
          ? 'First crossing starts the clock. Each crossing after it closes a lap. Gate-timed at both ends.'
          : `Tap Start rep, athlete goes from standing, the crossing ends it. Rest is never timed. Hand-started — about ±${HAND_START_ERROR_MS}ms per rep, not gate-accurate.`}
      </Text>

      <Pressable style={styles.tagBar} onPress={() => !live && setDrillOpen(true)} disabled={live}>
        <Text style={[styles.tagBarText, !drill && styles.tagBarPlaceholder]} numberOfLines={1}>
          {drill?.name || '＋  Drill (e.g. 1200m, 400m ×3)'}
        </Text>
      </Pressable>

      {/* Lockout, tunable live and persisted — locked during a set. */}
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
        Ignores a second break within this window, so one crossing is one interval. Raise it if a
        walk-back through the beam is registering as a lap.
      </Text>

      {/* Live set */}
      {live ? (
        <View style={styles.liveCard}>
          <Text style={styles.liveKicker}>
            {v2.repeatState === 'armed'
              ? 'WAITING FOR THE FIRST CROSSING'
              : v2.repeatState === 'resting'
                ? 'RESTING — TAP START REP'
                : 'RUNNING'}
          </Text>
          <Text style={styles.liveCount}>
            {liveIntervals.length} interval{liveIntervals.length === 1 ? '' : 's'}
          </Text>
          {liveIntervals.length ? (
            <Text style={styles.liveList} numberOfLines={2}>
              {liveIntervals.map((i) => `${fmt(i.ms)}s`).join('  ·  ')}
            </Text>
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
            <Text style={styles.btnText}>Start set</Text>
          </Pressable>
        ) : (
          <>
            {base.variant === 'rest' ? (
              <Pressable
                onPress={v2.startRep}
                disabled={v2.repeatState !== 'resting'}
                style={({ pressed }) => [
                  styles.btn,
                  styles.btnGo,
                  (v2.repeatState !== 'resting' || pressed) && styles.dim,
                ]}
              >
                <Text style={styles.btnText}>Start rep</Text>
              </Pressable>
            ) : null}
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

      {/* Review: the only place an interval can be dropped, and the last moment
          before anything is written. */}
      {shown ? (
        <View style={styles.review}>
          <Text style={styles.reviewTitle}>
            {shown.intervals.length} interval{shown.intervals.length === 1 ? '' : 's'} ·{' '}
            {shown.variant === 'continuous' ? 'total' : 'avg'}{' '}
            <Text style={styles.reviewNum}>{fmt(chartValueMs(shown))}s</Text>
          </Text>
          <Text style={styles.reviewSub}>
            total {fmt(shown.totalMs)}s · avg {fmt(shown.meanMs)}s
            {shown.exact ? '' : ` · hand-started, ±${HAND_START_ERROR_MS}ms per rep`}
          </Text>

          {shown.intervals.map((it, i) => (
            <View key={`${it.closeUs}-${i}`} style={styles.ivRow}>
              <Text style={styles.ivIndex}>{i + 1}</Text>
              <Text style={styles.ivTime}>{fmt(it.ms)}s</Text>
              <Pressable
                onPress={() => setReview(dropInterval(shown, i))}
                hitSlop={8}
                style={({ pressed }) => [styles.ivDrop, pressed && styles.dim]}
              >
                <Text style={styles.ivDropText}>Drop</Text>
              </Pressable>
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
              onPress={doSave}
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
  reviewSub: { color: '#64748b', fontSize: 11, marginTop: 3, marginBottom: 8 },
  ivRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 9,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#243042',
  },
  ivIndex: { color: '#475569', fontSize: 12, fontWeight: '800', width: 18 },
  ivTime: { color: '#e2e8f0', fontSize: 16, fontWeight: '700', flex: 1, fontVariant: ['tabular-nums'] },
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
