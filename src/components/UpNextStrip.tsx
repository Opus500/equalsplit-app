// The persistent "up next" strip: who this run is being recorded for, and who
// follows. Shared by all three timing screens so attribution works the same
// wherever you're timing from.
//
// Tapping it opens the picker to jump to anyone. A jump OVERRIDES the queue
// position without reordering the lineup (see ../roster/queue): pick someone in
// the lineup and the cursor moves there; pick someone outside it and they run
// once, then the lineup resumes exactly where it was.

import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useRoster } from '../roster/RosterProvider';
import { disambiguate } from '../roster/labels';
import { AthletePickerModal } from './AthletePicker';

export function UpNextStrip() {
  const roster = useRoster();
  const [picking, setPicking] = useState(false);

  const next = roster.upNext(2);
  const current = roster.currentAthlete;

  // Disambiguate across exactly who's on the strip, so two same-named athletes
  // in one lineup are still tellable apart at a glance mid-rep.
  const details = useMemo(
    () => disambiguate([current, ...next].filter((a) => a != null)),
    [current, next],
  );

  const overrideActive = roster.queue.overrideId != null;
  // Nothing to skip TO when the lineup is one athlete (or empty) and no one-off
  // jump is pending — skipping would be a no-op, so don't offer it.
  const canSkip = overrideActive || next.length > 0;

  return (
    <>
      <Pressable
        onPress={() => setPicking(true)}
        style={({ pressed }) => [styles.strip, pressed && styles.dim]}
      >
        <View style={styles.currentCol}>
          <Text style={styles.kicker}>
            {current ? (overrideActive ? 'UP NOW · JUMPED' : 'UP NOW') : 'NO ATHLETE'}
          </Text>
          <Text style={[styles.current, !current && styles.currentNone]} numberOfLines={1}>
            {current ? current.display_name : 'Tap to choose'}
          </Text>
          {current && details.get(current.id) ? (
            <Text style={styles.detail} numberOfLines={1}>
              {details.get(current.id)}
            </Text>
          ) : null}
        </View>

        <View style={styles.nextCol}>
          {next.length ? (
            <>
              <Text style={styles.kickerRight}>NEXT</Text>
              {next.map((a) => (
                <Text key={a.id} style={styles.nextName} numberOfLines={1}>
                  {a.display_name}
                  {details.get(a.id) ? <Text style={styles.nextDetail}>  {details.get(a.id)}</Text> : null}
                </Text>
              ))}
            </>
          ) : (
            <Text style={styles.nextEmpty}>{current ? 'end of lineup' : ''}</Text>
          )}
        </View>

        {/* Nested Pressable: it handles the press itself, so skipping never
            opens the picker. Skip is NOT removal — they keep their place and
            come round again on the wrap. */}
        {current ? (
          <Pressable
            onPress={roster.skipCurrent}
            disabled={!canSkip}
            hitSlop={8}
            style={({ pressed }) => [styles.skipBtn, (!canSkip || pressed) && styles.dim]}
          >
            <Text style={styles.skipText}>Skip</Text>
            <Text style={styles.skipGlyph}>⇥</Text>
          </Pressable>
        ) : null}
      </Pressable>

      {/* Skip is reversible: undo restores the whole pre-skip queue state, so the
          cursor (and any consumed one-off jump) comes back exactly — including
          the wrap, whose announcement is retracted with it. When a skip caused
          the wrap the two notices merge, rather than stacking two banners. */}
      {roster.lastSkip ? (
        <View style={styles.undoNotice}>
          <Text style={styles.undoText} numberOfLines={1}>
            Skipped {roster.lastSkip.name}
            {roster.lastSkip.wrapped ? ' · lineup restarted' : ''}
          </Text>
          <Pressable onPress={roster.undoSkip} hitSlop={10}>
            <Text style={styles.undoAction}>Undo</Text>
          </Pressable>
        </View>
      ) : roster.justWrapped ? (
        /* The wrap is announced, never silent: snapping back to the first
           athlete with no explanation reads as a bug mid-practice. */
        <View style={styles.wrapNotice}>
          <Text style={styles.wrapText}>↻  Restarting lineup from the top</Text>
        </View>
      ) : null}

      {overrideActive ? (
        <View style={styles.overrideNotice}>
          <Text style={styles.overrideText}>
            One-off — the lineup resumes after this run
          </Text>
        </View>
      ) : null}

      <AthletePickerModal
        visible={picking}
        currentId={current?.id ?? null}
        title="Who's up?"
        allowUnassigned={false}
        onClose={() => setPicking(false)}
        onPick={(id) => {
          if (id) roster.jumpTo(id);
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: '#161b22',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginTop: 6,
    borderWidth: 1,
    borderColor: '#243042',
  },
  currentCol: { flex: 1, minWidth: 0 },
  kicker: { color: '#64748b', fontSize: 10, fontWeight: '800', letterSpacing: 0.8 },
  kickerRight: { color: '#64748b', fontSize: 10, fontWeight: '800', letterSpacing: 0.8, textAlign: 'right' },
  current: { color: '#fff', fontSize: 20, fontWeight: '800', marginTop: 1 },
  currentNone: { color: '#64748b', fontSize: 16, fontWeight: '600' },
  detail: { color: '#8b98a9', fontSize: 11, marginTop: 1 },
  nextCol: { maxWidth: '38%', alignItems: 'flex-end' },
  skipBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#243042',
    backgroundColor: '#0b0e13',
  },
  skipText: { color: '#94a3b8', fontSize: 11, fontWeight: '800', letterSpacing: 0.3 },
  skipGlyph: { color: '#64748b', fontSize: 13, fontWeight: '800', marginTop: 1 },
  nextName: { color: '#94a3b8', fontSize: 12, marginTop: 2, textAlign: 'right' },
  nextDetail: { color: '#64748b', fontSize: 10 },
  nextEmpty: { color: '#475569', fontSize: 11 },
  wrapNotice: {
    backgroundColor: '#1e3a5f',
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
    marginTop: 6,
  },
  wrapText: { color: '#93c5fd', fontSize: 12, fontWeight: '700', textAlign: 'center' },
  undoNotice: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    backgroundColor: '#1f2937',
    borderRadius: 8,
    paddingVertical: 7,
    paddingHorizontal: 12,
    marginTop: 6,
    borderWidth: 1,
    borderColor: '#374151',
  },
  undoText: { color: '#cbd5e1', fontSize: 12, fontWeight: '600', flex: 1 },
  undoAction: { color: '#60a5fa', fontSize: 13, fontWeight: '800' },
  overrideNotice: { paddingTop: 6 },
  overrideText: { color: '#fbbf24', fontSize: 11, textAlign: 'center' },
  dim: { opacity: 0.7 },
});
