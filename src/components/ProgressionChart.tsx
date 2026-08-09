// A per-drill progression chart, hand-rolled from Views — no react-native-svg.
//
// A line chart is three primitives: horizontal rules (gridlines), circles (points)
// and rotated rectangles (segments). None of those need a drawing library, and the
// dependency would cost a native module on a build that currently prebuilds clean.
//
// The y-axis is TIME and increases upward, so an improving athlete's line FALLS.
// All the geometry lives in ../roster/progression (pure, verified by
// scripts/verify-progression.mjs) — this file only turns fractions into pixels.
//
// FIT TO WIDTH, never scroll. This chart lives inside the horizontally-paging
// drill ScrollView, so a horizontally scrollable plot would fight the page swipe
// for the same gesture in the same region. Density is handled by shrinking the
// marks instead (see DENSE_SPACING), which also keeps a whole season readable at
// once — the thing the chart is actually for.

import { useEffect, useMemo, useState } from 'react';
import { type LayoutChangeEvent, Pressable, StyleSheet, Text, View } from 'react-native';

import {
  formatMs,
  xFraction,
  yBounds,
  yFraction,
  yTicks,
  type Series,
} from '../roster/progression';

const PLOT_H = 152;
/** Room for "4.25s" without truncating — the labels are the chart's units. */
const AXIS_W = 48;
/** MUST match styles.wrap padding. onLayout reports the BORDER box, so the card's
 *  own padding has to be subtracted to get the width the children actually have. */
const CARD_PAD = 14;
const DOT = 10;
const DOT_SEL = 15;
/** Below this, a dot is a smudge; the line carries the shape instead. */
const DOT_MIN = 3;
/** Point spacing under which ordinary dots are dropped (PB and latest stay). */
const DENSE_SPACING = 7;
const LINE_W = 2;
/** Narrowest touch column. Columns tile exactly so every point is reachable; the
 *  readout's steppers are the precise path once they get this thin. */
const MIN_TOUCH_W = 6;

const shortDate = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function ProgressionChart({
  series,
  onDeleteRun,
}: {
  series: Series;
  /** Omit to hide the delete affordance. The caller owns the confirm + the delete. */
  onDeleteRun?: (runId: string) => void;
}) {
  const [width, setWidth] = useState(0);
  const [sel, setSel] = useState<number | null>(null);

  // A delete (or any reload) reshapes the series under us, so an index-based
  // selection would silently point at a DIFFERENT run — the same class of bug the
  // queue cursor avoids by keying on id. Cheapest correct fix: drop the selection
  // whenever the series changes shape.
  useEffect(() => setSel(null), [series.drillId, series.points.length]);

  const bounds = useMemo(() => yBounds(series), [series]);
  const ticks = useMemo(() => yTicks(bounds.min, bounds.max, 4), [bounds]);

  // The plot's real width: the card's content box, minus the axis gutter.
  const plotW = Math.max(0, width - CARD_PAD * 2 - AXIS_W);
  const n = series.points.length;

  // Inset by half a selected dot at each end so the first and last marks sit
  // FULLY inside the plot. With this, `overflow: hidden` below is free insurance
  // rather than something that clips real data.
  const inset = DOT_SEL / 2;
  const usableW = Math.max(0, plotW - DOT_SEL);
  const spacing = n > 1 ? usableW / (n - 1) : usableW;
  const dotSize = clamp(spacing * 0.8, DOT_MIN, DOT);
  // At a full season's density individual dots merge into a caterpillar and stop
  // meaning anything; the line is the signal. PB and latest are always drawn —
  // they are the two numbers in the stat row and must stay locatable.
  const dense = n > 2 && spacing < DENSE_SPACING;

  const pts = useMemo(
    () =>
      series.points.map((p, i) => ({
        ...p,
        x: inset + xFraction(i, n) * usableW,
        y: yFraction(p.elapsedMs, bounds.min, bounds.max) * PLOT_H,
      })),
    [series.points, n, usableW, inset, bounds],
  );

  // Segments as rotated rectangles. Rotation is about the CENTRE by default in RN,
  // so each one is positioned at the midpoint of its pair — no transformOrigin
  // needed, which keeps this working regardless of RN version.
  const segments = useMemo(() => {
    const out: { left: number; top: number; w: number; a: number }[] = [];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (!len) continue;
      out.push({
        left: (a.x + b.x) / 2 - len / 2,
        top: (a.y + b.y) / 2 - LINE_W / 2,
        w: len,
        a: Math.atan2(dy, dx),
      });
    }
    return out;
  }, [pts]);

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  const shown = sel != null ? pts[sel] : null;
  const step = (d: number) => {
    const base = sel == null ? (d > 0 ? -1 : n) : sel;
    setSel(clamp(base + d, 0, n - 1));
  };

  // Columns tile EXACTLY (no overlap), so every point stays reachable by tap even
  // when they are only a few points wide.
  const colW = Math.max(MIN_TOUCH_W, spacing);

  return (
    <View style={styles.wrap} onLayout={onLayout}>
      <View style={styles.headRow}>
        <Text style={styles.drill} numberOfLines={1}>
          {series.drillName}
        </Text>
        <Text style={styles.runCount}>
          {n} run{n === 1 ? '' : 's'}
        </Text>
      </View>

      {/* Best and latest only. A first→latest delta reads as a verdict on two
          arbitrary points — the chart already shows the shape between them. */}
      <View style={styles.statRow}>
        <Stat label="Best" value={`${formatMs(series.bestMs)}s`} tone="best" />
        <Stat label="Latest" value={`${formatMs(series.latestMs)}s`} />
      </View>

      <View style={styles.plotRow}>
        <View style={[styles.axis, { width: AXIS_W, height: PLOT_H }]}>
          {ticks.map((t) => (
            <Text
              key={t}
              style={[styles.axisLabel, { top: yFraction(t, bounds.min, bounds.max) * PLOT_H - 7 }]}
            >
              {formatMs(t)}s
            </Text>
          ))}
        </View>

        <View style={[styles.plot, { height: PLOT_H }]}>
          {plotW > 0 ? (
            <>
              {ticks.map((t) => (
                <View
                  key={t}
                  pointerEvents="none"
                  style={[styles.grid, { top: yFraction(t, bounds.min, bounds.max) * PLOT_H }]}
                />
              ))}

              {shown ? (
                <View pointerEvents="none" style={[styles.guide, { left: shown.x, height: PLOT_H }]} />
              ) : null}

              {segments.map((s, i) => (
                <View
                  key={i}
                  pointerEvents="none"
                  style={[
                    styles.segment,
                    {
                      left: s.left,
                      top: s.top,
                      width: s.w,
                      height: LINE_W,
                      transform: [{ rotate: `${s.a}rad` }],
                    },
                  ]}
                />
              ))}

              {pts.map((p, i) => {
                const isSel = sel === i;
                const isLatest = i === n - 1;
                // When dense, ordinary points are dropped — but never the PB, the
                // latest, or whatever is selected.
                if (dense && !p.isBest && !isLatest && !isSel) return null;
                const size = isSel ? DOT_SEL : dense ? Math.max(dotSize, DOT_MIN + 3) : dotSize;
                return (
                  <View
                    key={p.runId}
                    pointerEvents="none"
                    style={[
                      styles.dot,
                      p.isBest && styles.dotBest,
                      isSel && styles.dotSel,
                      {
                        width: size,
                        height: size,
                        borderRadius: size / 2,
                        left: p.x - size / 2,
                        top: p.y - size / 2,
                      },
                    ]}
                  />
                );
              })}

              {pts.map((p, i) => (
                <Pressable
                  key={`hit-${p.runId}`}
                  onPress={() => setSel(sel === i ? null : i)}
                  accessibilityRole="button"
                  accessibilityLabel={`Run ${i + 1} of ${n}, ${formatMs(p.elapsedMs)} seconds, ${shortDate(
                    p.createdAt,
                  )}${p.isBest ? ', personal best' : ''}`}
                  style={{
                    position: 'absolute',
                    left: p.x - colW / 2,
                    top: 0,
                    width: colW,
                    height: PLOT_H,
                  }}
                />
              ))}
            </>
          ) : null}
        </View>
      </View>

      <View style={[styles.xAxis, { marginLeft: AXIS_W }]}>
        <Text style={styles.xLabel}>{shortDate(series.points[0]!.createdAt)}</Text>
        <Text style={styles.xLabel}>{shortDate(series.points[n - 1]!.createdAt)}</Text>
      </View>

      {/* Fixed-height readout so selecting a point never reflows the list under it. */}
      <View style={styles.readout}>
        {/* Steppers: at a season's density a touch column is a few points wide and
            tapping the exact run you mean is luck. These reach any point precisely,
            at any density, and cost nothing. */}
        {n > 1 ? (
          <View style={styles.stepGroup}>
            <Pressable
              onPress={() => step(-1)}
              disabled={sel === 0}
              hitSlop={8}
              accessibilityLabel="Previous run"
              style={({ pressed }) => [styles.step, (sel === 0 || pressed) && styles.dimmed]}
            >
              <Text style={styles.stepText}>‹</Text>
            </Pressable>
            <Pressable
              onPress={() => step(1)}
              disabled={sel === n - 1}
              hitSlop={8}
              accessibilityLabel="Next run"
              style={({ pressed }) => [styles.step, (sel === n - 1 || pressed) && styles.dimmed]}
            >
              <Text style={styles.stepText}>›</Text>
            </Pressable>
          </View>
        ) : null}

        {shown ? (
          <>
            <Text style={styles.readoutText} numberOfLines={1}>
              <Text style={styles.readoutStrong}>Run {(sel ?? 0) + 1}</Text> ·{' '}
              {formatMs(shown.elapsedMs)}s · {shortDate(shown.createdAt)}
              {shown.isBest ? <Text style={styles.pbTag}>  ★ PB</Text> : null}
            </Text>
            {/* For junk data — a false start, someone walking through the beam.
                A real delete through the same path History uses, so the two can
                never disagree about which runs exist. */}
            {onDeleteRun ? (
              <Pressable
                onPress={() => onDeleteRun(shown.runId)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={`Delete run ${(sel ?? 0) + 1}, ${formatMs(shown.elapsedMs)} seconds`}
                style={({ pressed }) => [styles.delBtn, pressed && styles.dimmed]}
              >
                <Text style={styles.delText}>Delete</Text>
              </Pressable>
            ) : null}
          </>
        ) : (
          <Text style={styles.readoutHint} numberOfLines={1}>
            {dense ? 'Tap or step through runs · ★ best' : 'Tap a point for the run · ★ marks the best'}
          </Text>
        )}
      </View>
    </View>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'best' | 'good' | 'bad' }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text
        style={[
          styles.statValue,
          tone === 'best' && styles.statBest,
          tone === 'good' && styles.statGood,
          tone === 'bad' && styles.statBad,
        ]}
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: '#161b22',
    borderRadius: 14,
    padding: CARD_PAD,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#243042',
  },
  headRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 },
  drill: { color: '#fff', fontSize: 16, fontWeight: '800', flex: 1 },
  runCount: { color: '#64748b', fontSize: 12, fontWeight: '600' },
  statRow: { flexDirection: 'row', gap: 10, marginTop: 10, marginBottom: 14 },
  stat: { flex: 1 },
  statLabel: { color: '#64748b', fontSize: 10, fontWeight: '800', letterSpacing: 0.6 },
  statValue: { color: '#cbd5e1', fontSize: 15, fontWeight: '700', marginTop: 2 },
  statBest: { color: '#fbbf24' },
  statGood: { color: '#4ade80' },
  statBad: { color: '#fb923c' },
  plotRow: { flexDirection: 'row' },
  axis: { position: 'relative' },
  axisLabel: {
    position: 'absolute',
    right: 8,
    color: '#64748b',
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  // overflow hidden is insurance: the x-range is inset so nothing SHOULD reach the
  // edge, and if a geometry change ever breaks that it clips instead of drawing
  // over the card — the failure this replaced.
  plot: { flex: 1, position: 'relative', overflow: 'hidden' },
  grid: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#243042',
  },
  guide: { position: 'absolute', top: 0, width: StyleSheet.hairlineWidth, backgroundColor: '#3b82f6' },
  segment: { position: 'absolute', backgroundColor: '#3b82f6', borderRadius: LINE_W / 2 },
  dot: { position: 'absolute', backgroundColor: '#60a5fa', borderWidth: 1, borderColor: '#0e1116' },
  dotBest: { backgroundColor: '#fbbf24' },
  dotSel: { borderColor: '#fff', borderWidth: 2 },
  xAxis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
  xLabel: { color: '#475569', fontSize: 10 },
  readout: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  stepGroup: { flexDirection: 'row', gap: 4 },
  step: {
    width: 34,
    height: 34,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#243042',
    backgroundColor: '#0b0e13',
  },
  stepText: { color: '#93c5fd', fontSize: 18, fontWeight: '800', lineHeight: 20 },
  readoutText: { color: '#cbd5e1', fontSize: 13, flex: 1 },
  readoutStrong: { color: '#fff', fontWeight: '800' },
  readoutHint: { color: '#475569', fontSize: 12, flex: 1 },
  pbTag: { color: '#fbbf24', fontWeight: '800' },
  delBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#7f1d1d',
    backgroundColor: '#1a1214',
  },
  delText: { color: '#f87171', fontSize: 12, fontWeight: '800' },
  dimmed: { opacity: 0.5 },
});
