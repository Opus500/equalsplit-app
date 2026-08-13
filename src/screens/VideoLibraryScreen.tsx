// Stage 2: the videos stored in the app — what they cost, and how to get rid of
// them.
//
// This exists because Stage 1 dropped "keep time only". Every marked run now
// keeps its clip, clips live in the DOCUMENT directory so iOS will not evict
// them, and at roughly 1MB per second of 1080p a few sessions is a few hundred
// megabytes with no way to reclaim any of it. Delete is not a convenience here,
// it is the other half of storing anything at all.
//
// "No storage dashboard, but blind deletion is useless." So each clip is shown
// against the RUN it belongs to — athlete, drill, time, date — and its size. A
// list of filenames and byte counts would technically satisfy "show the size"
// while leaving the coach unable to choose.
//
// The two ways a clip and a run come apart both get their own treatment rather
// than being hidden: an ORPHAN (imported, never saved) is pure waste and is
// labelled as such, and a run whose clip was deleted keeps its time, which is by
// design and not a broken state.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
// The class-based API, not the legacy shim. saveToLibraryAsync now comes from
// legacyWarnings and warns on every call; Asset.create is its replacement.
// requestPermissionsAsync is exported from the module root and is NOT deprecated
// — only the asset verbs moved.
import { Asset, requestPermissionsAsync } from 'expo-media-library';

import { VideoPlayerModal } from '../components/VideoPlayerModal';
import { clearMissingClips, listVideoRuns, type VideoRunRow } from '../db/database';
import {
  deleteClip,
  formatBytes,
  listClips,
  sweepBrokenClips,
  totalBytes,
  type Clip,
} from '../video/clips';
import { formatVideoSeconds, VIDEO_MODE } from '../video/timing';

type Entry = {
  clip: Clip;
  run: VideoRunRow | null;
};

export default function VideoLibraryScreen() {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [working, setWorking] = useState<string | null>(null);
  const [playing, setPlaying] = useState<Entry | null>(null);

  /** Runs whose clip is gone. Not an error — deleting a video keeps the run, and
   *  saying so stops it reading as data loss. */
  const [orphanRuns, setOrphanRuns] = useState(0);
  /** Half-written clips cleared on this visit. Reported rather than done quietly:
   *  space appearing from nowhere is the kind of thing a coach should be told. */
  const [swept, setSwept] = useState(0);

  const load = useCallback(async () => {
    // Before listing, not after: a directory left by an import that died partway
    // holds no playable video and no recoverable time, and leaving it would put a
    // row here offering Play, Camera roll and Share on a file that has none of it.
    setSwept(sweepBrokenClips());
    const clips = listClips();
    const runs = await listVideoRuns();
    // Clip references that no longer resolve are cleared here rather than left to
    // rot: a run claiming footage it does not have would show a Play button that
    // opens nothing. The count is reported, not hidden.
    const cleared = await clearMissingClips(clips.map((c) => c.id));
    setOrphanRuns(cleared);

    const byClip = new Map<string, VideoRunRow>();
    for (const r of runs) byClip.set(r.clip_id, r);
    setEntries(clips.map((clip) => ({ clip, run: byClip.get(clip.id) ?? null })));
    setTotal(totalBytes());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const confirmDelete = useCallback(
    (entry: Entry) => {
      const what = entry.run
        ? `${formatVideoSeconds(entry.run.total_ms)}s · ${entry.run.drill_name ?? 'no drill'} · ${
            entry.run.athlete_name ?? 'Unassigned'
          }`
        : 'Imported but never saved';
      Alert.alert(
        'Delete this video?',
        `${what}\n${formatBytes(entry.clip.bytes)}\n\n` +
          (entry.run
            ? 'The RUN and its time are kept — only the video is removed. This cannot be undone.'
            : 'No run was ever saved from this clip.'),
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete video',
            style: 'destructive',
            onPress: () => {
              try {
                deleteClip(entry.clip.id);
                void load();
              } catch (e) {
                Alert.alert('Delete failed', String(e));
              }
            },
          },
        ],
      );
    },
    [load],
  );

  const exportToRoll = useCallback(async (entry: Entry) => {
    setWorking(entry.clip.id);
    try {
      // Write-only permission: the app never needs to READ the camera roll to put
      // something into it, and asking for full access to do a save is asking for
      // more than the job requires.
      const perm = await requestPermissionsAsync(true);
      if (!perm.granted) {
        Alert.alert('Photos access needed', 'EqualSplit needs permission to save into your camera roll.');
        return;
      }
      await Asset.create(entry.clip.uri);
      Alert.alert('Saved', 'The video is in your camera roll. It stays in the app too.');
    } catch (e) {
      Alert.alert('Could not save', String(e));
    } finally {
      setWorking(null);
    }
  }, []);

  const share = useCallback(async (entry: Entry) => {
    try {
      // RN's own Share takes a file URL on iOS, so the share sheet costs no extra
      // dependency.
      await Share.share({ url: entry.clip.uri });
    } catch (e) {
      Alert.alert('Could not share', String(e));
    }
  }, []);

  const body = useMemo(() => {
    if (!entries) return <Text style={styles.muted}>Loading…</Text>;
    if (!entries.length) {
      return (
        <View style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>No videos stored</Text>
          <Text style={styles.emptyBody}>
            Clips you mark are kept here with their runs. This is where you free the space back up.
          </Text>
        </View>
      );
    }
    return entries.map((e) => {
      // Three genuinely different things, and they look identical as files.
      // A video-TIMED run got its number from these frames. An attached clip is
      // review footage on a run timed by something else — deleting it loses
      // footage but no measurement. An orphan is neither and is pure waste.
      const kind = !e.run ? 'orphan' : e.run.mode === VIDEO_MODE ? 'timed' : 'attached';
      return (
        <View key={e.clip.id} style={styles.card}>
          <View style={styles.cardHead}>
            <View style={styles.cardText}>
              <Text style={styles.cardTitle} numberOfLines={1}>
                {e.run
                  ? `${formatVideoSeconds(e.run.total_ms)}s · ${e.run.drill_name ?? 'no drill'}`
                  : 'Never saved'}
              </Text>
              <Text style={styles.cardSub} numberOfLines={1}>
                {e.run
                  ? `${e.run.athlete_name ?? 'Unassigned'} · ${dateOf(e.run.created_at)}`
                  : 'Imported, then left — no run was recorded'}
              </Text>
              <Text style={[styles.kind, styles[`kind_${kind}`]]}>
                {kind === 'timed'
                  ? 'TIMED FROM THIS VIDEO'
                  : kind === 'attached'
                    ? 'REVIEW FOOTAGE · run timed separately'
                    : 'NO RUN — SAFE TO DELETE'}
              </Text>
            </View>
            <Text style={[styles.size, kind === 'orphan' && styles.sizeWaste]}>
              {formatBytes(e.clip.bytes)}
            </Text>
          </View>
          <View style={styles.actions}>
            <Pressable style={styles.action} onPress={() => setPlaying(e)}>
              <Text style={[styles.actionText, styles.play]}>Play</Text>
            </Pressable>
            <Pressable
              style={styles.action}
              onPress={() => void exportToRoll(e)}
              disabled={working === e.clip.id}
            >
              <Text style={styles.actionText}>
                {working === e.clip.id ? 'Saving…' : 'Camera roll'}
              </Text>
            </Pressable>
            <Pressable style={styles.action} onPress={() => void share(e)}>
              <Text style={styles.actionText}>Share</Text>
            </Pressable>
            <Pressable style={styles.action} onPress={() => confirmDelete(e)}>
              <Text style={[styles.actionText, styles.danger]}>Delete</Text>
            </Pressable>
          </View>
        </View>
      );
    });
  }, [entries, working, confirmDelete, exportToRoll, share]);

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>Videos</Text>
        {/* The total is the point of the screen, so it sits in the header rather
            than being something to add up from the rows. */}
        <Text style={styles.total}>
          {entries?.length ?? 0} clip{entries?.length === 1 ? '' : 's'} · {formatBytes(total)}
        </Text>
      </View>

      {working ? <ActivityIndicator color="#93c5fd" style={styles.spinner} /> : null}

      <ScrollView contentContainerStyle={styles.body}>
        {body}
        {orphanRuns > 0 ? (
          <Text style={styles.footnote}>
            {orphanRuns} video run{orphanRuns === 1 ? '' : 's'} no longer{' '}
            {orphanRuns === 1 ? 'has' : 'have'} a clip. The times are kept — deleting a video never
            deletes its run.
          </Text>
        ) : null}
        {swept > 0 ? (
          <Text style={styles.footnote}>
            {swept} unfinished import{swept === 1 ? '' : 's'} cleared. These were left behind when a
            copy was interrupted; they held no video and no run.
          </Text>
        ) : null}
      </ScrollView>

      <VideoPlayerModal
        visible={!!playing}
        clipId={playing?.clip.id ?? null}
        title={
          playing?.run
            ? `${formatVideoSeconds(playing.run.total_ms)}s · ${playing.run.drill_name ?? 'no drill'}`
            : 'Unsaved clip'
        }
        subtitle={
          playing?.run
            ? `${playing.run.athlete_name ?? 'Unassigned'} · ${dateOf(playing.run.created_at)}`
            : undefined
        }
        onClose={() => setPlaying(null)}
      />
    </View>
  );
}

const dateOf = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: '2-digit' });

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0e1116' },
  header: {
    paddingTop: 56,
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#243042',
  },
  title: { color: '#fff', fontSize: 22, fontWeight: '800' },
  total: { color: '#94a3b8', fontSize: 13, marginTop: 2 },
  spinner: { marginTop: 10 },
  body: { padding: 12, gap: 10, paddingBottom: 40 },
  muted: { color: '#64748b', textAlign: 'center', marginTop: 32 },
  emptyCard: { backgroundColor: '#161b22', borderRadius: 12, padding: 18, gap: 6 },
  emptyTitle: { color: '#e2e8f0', fontSize: 16, fontWeight: '700' },
  emptyBody: { color: '#94a3b8', fontSize: 13, lineHeight: 19 },
  card: {
    backgroundColor: '#131a24',
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#243042',
    overflow: 'hidden',
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12 },
  cardText: { flex: 1, minWidth: 0 },
  cardTitle: { color: '#e2e8f0', fontSize: 15, fontWeight: '700' },
  cardSub: { color: '#94a3b8', fontSize: 12, marginTop: 2 },
  size: { color: '#cbd5e1', fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  /** An orphan is pure waste, so its size is the thing to notice. */
  sizeWaste: { color: '#fbbf24' },
  kind: { fontSize: 10, fontWeight: '700', letterSpacing: 0.4, marginTop: 4 },
  kind_timed: { color: '#34d399' },
  kind_attached: { color: '#60a5fa' },
  kind_orphan: { color: '#fbbf24' },
  play: { color: '#60a5fa' },
  actions: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#243042' },
  action: { flex: 1, alignItems: 'center', paddingVertical: 12 },
  actionText: { color: '#cbd5e1', fontSize: 12, fontWeight: '600' },
  danger: { color: '#f87171' },
  footnote: { color: '#64748b', fontSize: 11, lineHeight: 16, paddingHorizontal: 4, marginTop: 4 },
});
