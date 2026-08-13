// Play back the clip belonging to a run.
//
// One component, three call sites (the athlete chart's run list, History, and the
// video library), so "watch this run" behaves identically wherever it is reached
// from.
//
// Native controls, not the marking screen's scrubber: this is review, not
// measurement. Frame-accurate seeking exists to place a mark, and a mark has
// already been placed — here the coach wants scrub, pause, and replay, which the
// system controls do better than anything worth rebuilding.
//
// A missing clip is a NORMAL state, not an error. Deleting a video never deletes
// its run, so a run can outlive its footage by design, and this says so plainly
// rather than showing a broken player.
//
// A clip that is PRESENT but will not load is a different thing and gets its own
// message. It is the residue of an import that died partway — the file is real,
// the bytes are not a video — and telling the coach "video deleted" there would
// send them looking for something they never lost.

import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useVideoPlayer, VideoView } from 'expo-video';

import { formatBytes, getClip, type Clip } from '../video/clips';

export function VideoPlayerModal({
  visible,
  clipId,
  title,
  subtitle,
  onClose,
}: {
  visible: boolean;
  clipId: string | null;
  /** What run this is, so the sheet is not just an anonymous video. */
  title?: string;
  subtitle?: string;
  onClose: () => void;
}) {
  const [clip, setClip] = useState<Clip | null>(null);
  /** null = still resolving. 'gone' = no file. 'broken' = a file that will not load. */
  const [problem, setProblem] = useState<'gone' | 'broken' | null>(null);

  const player = useVideoPlayer(null, (p) => {
    p.muted = false;
    p.loop = true;
  });

  useEffect(() => {
    if (!visible || !clipId) {
      setClip(null);
      setProblem(null);
      return;
    }
    const found = getClip(clipId);
    setClip(found);
    setProblem(found ? null : 'gone');
    if (!found) return;
    let alive = true;
    // CAUGHT, not just chained. replaceAsync rejects on a file AVFoundation
    // cannot open, and an unhandled rejection here left the sheet showing a
    // permanently black player with nothing said — the one failure mode that
    // looks exactly like the app hanging.
    player
      .replaceAsync(found.uri)
      .then(() => {
        // Autoplay: the coach opened this to watch it, and the loop means they do
        // not have to catch a two-second clip on the first pass.
        if (alive) player.play();
      })
      .catch(() => {
        if (alive) setProblem('broken');
      });
    return () => {
      alive = false;
      player.pause();
    };
  }, [visible, clipId, player]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet">
      <View style={styles.root}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.title} numberOfLines={1}>
              {title ?? 'Run video'}
            </Text>
            {subtitle ? (
              <Text style={styles.sub} numberOfLines={1}>
                {subtitle}
              </Text>
            ) : null}
          </View>
          <Pressable onPress={onClose} hitSlop={10} style={({ pressed }) => [pressed && styles.dim]}>
            <Text style={styles.close}>Done</Text>
          </Pressable>
        </View>

        <View style={styles.stage}>
          {problem === 'gone' ? (
            <View style={styles.emptyCard}>
              <Text style={styles.emptyTitle}>Video deleted</Text>
              <Text style={styles.emptyBody}>
                This run&apos;s video was removed to free space. The time is unaffected — deleting a
                video never deletes its run.
              </Text>
            </View>
          ) : problem === 'broken' ? (
            <View style={styles.emptyCard}>
              <Text style={styles.emptyTitle}>This video won&apos;t play</Text>
              <Text style={styles.emptyBody}>
                The file is here but cannot be read — usually an import that was interrupted. The
                run and its time are unaffected. Delete it from Videos to free the space.
              </Text>
            </View>
          ) : clip ? (
            <VideoView player={player} style={styles.video} contentFit="contain" nativeControls />
          ) : (
            <Text style={styles.muted}>Loading…</Text>
          )}
        </View>

        {clip && problem !== 'broken' ? (
          <Text style={styles.footnote}>{formatBytes(clip.bytes)} · stored in the app</Text>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0e1116' },
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
  title: { color: '#fff', fontSize: 18, fontWeight: '800' },
  sub: { color: '#94a3b8', fontSize: 13, marginTop: 1 },
  close: { color: '#60a5fa', fontSize: 16, fontWeight: '700' },
  dim: { opacity: 0.5 },
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 12 },
  video: { width: '100%', height: '100%' },
  muted: { color: '#64748b', fontSize: 13 },
  emptyCard: { backgroundColor: '#161b22', borderRadius: 12, padding: 18, gap: 6 },
  emptyTitle: { color: '#e2e8f0', fontSize: 16, fontWeight: '700' },
  emptyBody: { color: '#94a3b8', fontSize: 13, lineHeight: 19 },
  footnote: { color: '#64748b', fontSize: 11, textAlign: 'center', paddingBottom: 22 },
});
