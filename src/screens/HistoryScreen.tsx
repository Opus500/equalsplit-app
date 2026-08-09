// Session history. A session = one calendar day of runs. Tap a session to see
// its runs, with a run count (+ an average only when the visible runs are a
// comparable set — one drill type and one mode), an athlete filter, per-run
// delete, and tap-a-run to edit its athlete/drill tags. No session "best": a
// session can mix incomparable modes/drills. Totals are the raw gate measurement
// (the reaction correction is unreliable; see LATENCY.md).

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  deleteRun,
  getRuns,
  getSessions,
  resolvedAthlete,
  resolvedDrill,
  setSessionName,
  updateRunAthlete,
  updateRunDrill,
  type RunRow,
  type SessionRow,
} from '../db/database';
import { useSettings } from '../settings/SettingsProvider';
import { formatTags } from '../runs/format';
import { AthletePickerModal } from '../components/AthletePicker';
import { DrillPickerModal } from '../components/DrillPicker';
import { runShareLine, sessionShareText, shareText } from '../share';

const fmt = (ms: number) => (Math.max(0, ms) / 1000).toFixed(3);
// Display label: the custom name if set, else the auto date. The date (s.name)
// stays available as a subtitle so a renamed session still shows when it was.
const sessionLabel = (s: SessionRow) => (s.custom_name?.trim() ? s.custom_name.trim() : s.name);
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
  const [picking, setPicking] = useState(false);
  const [pickingDrill, setPickingDrill] = useState(false);
  const [renaming, setRenaming] = useState(false);

  const loadSessions = useCallback(async () => {
    setSessions(await getSessions());
  }, []);

  const renameSelected = useCallback(
    async (name: string) => {
      if (!selected) return;
      await setSessionName(selected.id, name);
      setSelected({ ...selected, custom_name: name.trim() || null });
      await loadSessions();
    },
    [selected, loadSessions],
  );

  useEffect(() => {
    if (isActive && !selected) loadSessions();
  }, [isActive, selected, loadSessions]);

  const openSession = useCallback(async (s: SessionRow) => {
    setSelected(s);
    setAthleteFilter(null);
    setRuns(await getRuns(s.id));
  }, []);

  const refreshRuns = useCallback(async () => {
    if (selected) setRuns(await getRuns(selected.id));
  }, [selected]);

  // Reassignment goes through the roster by ID — never by name text.
  const reassign = useCallback(
    async (athleteId: string | null) => {
      if (!editing) return;
      await updateRunAthlete(editing.id, athleteId);
      await refreshRuns();
      setEditing((cur) => (cur ? { ...cur, athlete_id: athleteId } : cur));
    },
    [editing, refreshRuns],
  );

  const setDrill = useCallback(
    async (drillId: string | null) => {
      if (!editing) return;
      await updateRunDrill(editing.id, drillId);
      await refreshRuns();
      setEditing((cur) => (cur ? { ...cur, drill_id: drillId } : cur));
    },
    [editing, refreshRuns],
  );

  const confirmDelete = useCallback(
    (run: RunRow) => {
      Alert.alert('Delete run', `Delete run #${run.display_index} (${fmt(totalOf(run))}s)?`, [
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
    // Filter by athlete RECORD, not name text, so two same-named athletes are
    // separate chips and a rename doesn't split someone's history in two.
    // Key '' = Unassigned, which is a real state worth filtering to (it's how you
    // find the runs still needing attribution — 366 of them after migration).
    const seen = new Map<string, string>(); // key -> chip label
    for (const r of runs) {
      const key = r.athlete_id ?? '';
      if (seen.has(key)) continue;
      const { name, archived } = resolvedAthlete(r);
      seen.set(key, key === '' ? 'Unassigned' : `${name ?? '—'}${archived ? ' (archived)' : ''}`);
    }
    const athletes = [...seen.entries()];
    const shown = athleteFilter == null ? runs : runs.filter((r) => (r.athlete_id ?? '') === athleteFilter);
    // Average only when the visible valid runs are actually comparable: one drill
    // type AND one mode. Otherwise an average mixes incomparable runs, so omit it.
    const validShown = shown.filter((r) => r.status === 'valid');
    // Group by drill RECORD: '30m' vs '30M' must not read as two drills.
    const drillSet = new Set(validShown.map((r) => r.drill_id ?? (r.drill_type ?? '').trim()));
    const modeSet = new Set(validShown.map((r) => r.mode));
    const comparable = validShown.length > 0 && drillSet.size === 1 && modeSet.size === 1;
    const avg = comparable
      ? validShown.reduce((a, r) => a + totalOf(r), 0) / validShown.length
      : null;
    const avgDrill = comparable ? resolvedDrill(validShown[0]).name : null;
    const avgLabel = `Avg${avgDrill ? ` · ${avgDrill}` : ` · M${[...modeSet][0]}`}`;

    return (
      <View style={styles.container}>
        <View style={styles.headerRow}>
          <Pressable onPress={() => setSelected(null)} hitSlop={10}>
            <Text style={styles.back}>‹</Text>
          </Pressable>
          <Pressable style={styles.titleCol} onPress={() => setRenaming(true)} hitSlop={6}>
            <Text style={styles.detailTitle} numberOfLines={1}>
              {sessionLabel(selected)} <Text style={styles.editHint}>✎</Text>
            </Text>
            {selected.custom_name?.trim() ? (
              <Text style={styles.titleSub}>{selected.name}</Text>
            ) : null}
          </Pressable>
          {shown.length ? (
            <Pressable
              onPress={() =>
                shareText(
                  sessionShareText(
                    sessionLabel(selected),
                    selected.name,
                    // Resolve through the roster so shared text matches what's on
                    // screen (a renamed athlete must not export their old name).
                    [...shown]
                      .sort((a, b) => a.run_index - b.run_index)
                      .map((r) => ({
                        athleteName: resolvedAthlete(r).name,
                        drillType: resolvedDrill(r).name,
                        totalMs: r.total_ms,
                      })),
                  ),
                )
              }
              style={({ pressed }) => [styles.headerShare, pressed && { opacity: 0.6 }]}
            >
              <Text style={styles.headerShareText}>⤴ Share</Text>
            </Pressable>
          ) : null}
        </View>

        {athletes.length ? (
          <View style={styles.filterRow}>
            <FilterChip label="All" active={athleteFilter == null} onPress={() => setAthleteFilter(null)} />
            {athletes.map(([key, label]) => (
              <FilterChip
                key={key || '__unassigned'}
                label={label}
                active={athleteFilter === key}
                onPress={() => setAthleteFilter((cur) => (cur === key ? null : key))}
              />
            ))}
          </View>
        ) : null}

        <View style={styles.summary}>
          <Stat label="Runs" value={`${shown.length}`} />
          {avg != null ? <Stat label={avgLabel} value={`${fmt(avg)}s`} /> : null}
        </View>

        <FlatList
          data={shown}
          keyExtractor={(r) => r.id}
          ListEmptyComponent={<Text style={styles.empty}>No runs.</Text>}
          renderItem={({ item }) => {
            const meta = parseMeta(item);
            const who = resolvedAthlete(item);
            const tags = formatTags(who.name, resolvedDrill(item).name);
            return (
              <Pressable style={styles.runRow} onPress={() => setEditing(item)}>
                <View style={styles.runLeft}>
                  <View style={styles.runLeftTop}>
                    <Text style={styles.runIdx}>#{item.display_index}</Text>
                    <Text style={styles.runMode}>M{item.mode}</Text>
                  </View>
                  <Text
                    style={[
                      styles.runTags,
                      !tags && styles.runTagsEmpty,
                      // legacy = a name that never got linked to a roster record
                      who.legacy && styles.runTagsLegacy,
                    ]}
                    numberOfLines={1}
                  >
                    {tags || '+ assign'}
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
                <Pressable
                  onPress={() =>
                    shareText(
                      runShareLine(resolvedAthlete(item).name, resolvedDrill(item).name, item.total_ms),
                    )
                  }
                  hitSlop={8}
                  style={styles.rowIcon}
                >
                  <Text style={styles.shareGlyph}>⤴</Text>
                </Pressable>
                <Pressable onPress={() => confirmDelete(item)} hitSlop={10} style={styles.rowIcon}>
                  <Text style={styles.delText}>✕</Text>
                </Pressable>
              </Pressable>
            );
          }}
        />

        <RunEditModal
          run={editing}
          onClose={() => setEditing(null)}
          onOpenPicker={() => setPicking(true)}
          onOpenDrillPicker={() => setPickingDrill(true)}
        />

        {/* Reassignment (a stated requirement, not a follow-up): pick the record,
            store the id. Rendered above the editor so it stacks over it. */}
        <AthletePickerModal
          visible={picking}
          currentId={editing?.athlete_id ?? null}
          title={editing ? `Athlete for run #${editing.display_index}` : 'Choose athlete'}
          onClose={() => setPicking(false)}
          onPick={reassign}
        />

        {/* 'all' here, unlike the timers: re-tagging a run may legitimately
            target an engine drill (L Drill / Shuttle Run). */}
        <DrillPickerModal
          visible={pickingDrill}
          currentId={editing?.drill_id ?? null}
          kind="all"
          title={editing ? `Drill for run #${editing.display_index}` : 'Choose drill'}
          onClose={() => setPickingDrill(false)}
          onPick={(d) => setDrill(d?.id ?? null)}
        />

        <RenameModal
          visible={renaming}
          initial={selected.custom_name ?? ''}
          dateName={selected.name}
          onClose={() => setRenaming(false)}
          onSubmit={renameSelected}
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
            <View style={{ flex: 1 }}>
              <Text style={styles.sessName} numberOfLines={1}>
                {sessionLabel(item)}
              </Text>
              <Text style={styles.sessSub}>
                {item.custom_name?.trim() ? `${item.name} · ` : ''}
                {item.runCount} run{item.runCount === 1 ? '' : 's'}
              </Text>
            </View>
            <Text style={styles.chev}>›</Text>
          </Pressable>
        )}
      />
    </View>
  );
}

/** Edit one run: who it belongs to (roster record, via the picker) and its drill
 *  label. Athlete is deliberately NOT a text field any more — free text is what
 *  the roster replaced, and typing a name here would recreate the problem. */
function RunEditModal({
  run,
  onClose,
  onOpenPicker,
  onOpenDrillPicker,
}: {
  run: RunRow | null;
  onClose: () => void;
  onOpenPicker: () => void;
  onOpenDrillPicker: () => void;
}) {
  if (!run) return null;
  const who = resolvedAthlete(run);
  const drill = resolvedDrill(run);
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.rmBackdrop} onPress={onClose}>
        <Pressable style={styles.rmCard} onPress={() => {}}>
          <Text style={styles.rmTitle}>Run #{run.display_index}</Text>

          <Text style={styles.editLabel}>Athlete</Text>
          <Pressable
            onPress={onOpenPicker}
            style={({ pressed }) => [styles.athleteBtn, pressed && { opacity: 0.6 }]}
          >
            <Text style={[styles.athleteName, !who.name && styles.athleteNone]} numberOfLines={1}>
              {who.name ?? 'Unassigned'}
            </Text>
            <Text style={styles.athleteChange}>Change ›</Text>
          </Pressable>
          {who.legacy ? (
            <Text style={styles.legacyNote}>
              Old free-text tag, not linked to a roster athlete. Pick one to link it.
            </Text>
          ) : null}
          {who.archived ? <Text style={styles.legacyNote}>This athlete is archived.</Text> : null}

          <Text style={[styles.editLabel, { marginTop: 16 }]}>Drill</Text>
          <Pressable
            onPress={onOpenDrillPicker}
            style={({ pressed }) => [styles.athleteBtn, pressed && { opacity: 0.6 }]}
          >
            <Text style={[styles.athleteName, !drill.name && styles.athleteNone]} numberOfLines={1}>
              {drill.name ?? 'No drill'}
            </Text>
            <Text style={styles.athleteChange}>Change ›</Text>
          </Pressable>
          {drill.legacy ? (
            <Text style={styles.legacyNote}>
              Old free-text label, not linked to a drill record. Pick one to link it.
            </Text>
          ) : null}

          <Pressable
            onPress={onClose}
            style={({ pressed }) => [styles.rmBtn, styles.rmBtnPrimary, { marginTop: 18 }, pressed && { opacity: 0.6 }]}
          >
            <Text style={[styles.rmBtnText, styles.rmBtnPrimaryText]}>Done</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
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

function RenameModal({
  visible,
  initial,
  dateName,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  initial: string;
  dateName: string;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [text, setText] = useState(initial);
  useEffect(() => {
    if (visible) setText(initial);
  }, [visible, initial]);
  const submit = () => {
    onSubmit(text.trim());
    onClose();
  };
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <Pressable style={styles.rmBackdrop} onPress={onClose}>
          <Pressable style={styles.rmCard} onPress={() => {}}>
            <Text style={styles.rmTitle}>Rename session</Text>
            <TextInput
              style={styles.rmInput}
              value={text}
              onChangeText={setText}
              placeholder={dateName}
              placeholderTextColor="#475569"
              autoFocus
              returnKeyType="done"
              onSubmitEditing={submit}
            />
            <Text style={styles.rmNote}>Leave empty to use the date ({dateName}).</Text>
            <View style={styles.rmActions}>
              <Pressable onPress={onClose} style={({ pressed }) => [styles.rmBtn, pressed && { opacity: 0.5 }]}>
                <Text style={styles.rmBtnText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={submit}
                style={({ pressed }) => [styles.rmBtn, styles.rmBtnPrimary, pressed && { opacity: 0.5 }]}
              >
                <Text style={[styles.rmBtnText, styles.rmBtnPrimaryText]}>Save</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0e1116', paddingTop: 56, paddingHorizontal: 16 },
  flex: { flex: 1 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 8 },
  back: { color: '#60a5fa', fontSize: 26, fontWeight: '700', marginTop: -4 },
  titleCol: { flexShrink: 1, flex: 1 },
  detailTitle: { color: '#fff', fontSize: 20, fontWeight: '800' },
  editHint: { color: '#60a5fa', fontSize: 14 },
  titleSub: { color: '#64748b', fontSize: 12, marginTop: 1 },
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
  runTagsLegacy: { color: '#7a6a4a', fontStyle: 'italic' },
  editLabel: { color: '#94a3b8', fontSize: 13, fontWeight: '700', marginBottom: 6 },
  athleteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#0b0e13',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: '#243042',
  },
  athleteName: { color: '#fff', fontSize: 16, fontWeight: '700', flex: 1 },
  athleteNone: { color: '#64748b', fontWeight: '600' },
  athleteChange: { color: '#60a5fa', fontSize: 13, fontWeight: '700' },
  legacyNote: { color: '#fbbf24', fontSize: 11, lineHeight: 16, marginTop: 6 },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  customDrill: { color: '#64748b', fontSize: 11, marginTop: 8 },
  runM2: { alignItems: 'flex-end', marginRight: 10 },
  runSplits: { color: '#64748b', fontSize: 13, fontVariant: ['tabular-nums'] },
  runUnreliable: { color: '#fb923c', fontWeight: '700' },
  runConf: { color: '#38bdf8', fontSize: 10, fontWeight: '700', marginTop: 1, fontVariant: ['tabular-nums'] },
  runConfDim: { color: '#475569', fontSize: 10, marginTop: 1 },
  runTotal: { color: '#fff', fontSize: 16, fontWeight: '800', fontVariant: ['tabular-nums'] },
  rowIcon: { paddingHorizontal: 6, paddingVertical: 2 },
  shareGlyph: { color: '#60a5fa', fontSize: 16, fontWeight: '800' },
  delText: { color: '#b4541f', fontSize: 16, fontWeight: '800' },
  headerShare: {
    backgroundColor: '#1f2937',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: '#374151',
  },
  headerShareText: { color: '#e2e8f0', fontSize: 13, fontWeight: '700' },
  rmBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  rmCard: { backgroundColor: '#161b22', borderRadius: 16, padding: 18 },
  rmTitle: { color: '#fff', fontSize: 17, fontWeight: '800', marginBottom: 12 },
  rmInput: {
    backgroundColor: '#0b0e13',
    color: '#fff',
    fontSize: 16,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  rmNote: { color: '#64748b', fontSize: 11, marginTop: 8 },
  rmActions: { flexDirection: 'row', gap: 10, marginTop: 16 },
  rmBtn: { flex: 1, backgroundColor: '#243042', borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  rmBtnText: { color: '#cbd5e1', fontWeight: '700' },
  rmBtnPrimary: { backgroundColor: '#2563eb' },
  rmBtnPrimaryText: { color: '#fff' },
});
