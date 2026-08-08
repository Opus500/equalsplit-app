// A per-drill progression chart, hand-rolled from Views — no react-native-svg.
//
// A line chart is three primitives: horizontal rules (gridlines), circles (points)
// and rotated rectangles (segments). None of those need a drawing library, and the
// dependency would cost a native module on a build that currently prebuilds clean.
//
// The y-axis is TIME and increases upward, so an improving athlete's line FALLS.
// All the geometry lives in ../roster/progression (pure, verified by
// scripts/verify-progression.mjs) — this file only turns fractions into pixels.

import { useMemo, useState } from 'react';
import { type LayoutChangeEvent, Pressable, StyleSheet, Text, View } from 'react-native';

import {
  formatDelta,
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
/** Keeps the last dot (and its ring) off the right edge. */
const PAD_R = 14;
const DOT = 10;
const DOT_SEL = 15;
const LINE_W = 2;
/** Minimum tappable column. Below this the series is denser than the finger. */
const MIN_TOUCH_W = 16;

const shortDate = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

export function ProgressionChart({ series }: { series: Series }) {
  const [width, setWidth] = useState(0);
  const [sel, setSel] = useState<number | null>(null);

  const bounds = useMemo(() => yBounds(series), [series]);
  const ticks = useMemo(() => yTicks(bounds.min, bounds.max, 4), [bounds]);

  const plotW = Math.max(0, width - AXIS_W - PAD_R);
  const n = series.points.length;

  const pts = useMemo(
    () =>
      series.points.map((p, i) => ({
        ...p,
        x: xFraction(i, n) * plotW,
        y: yFraction(p.elapsedMs, bounds.min, bounds.max) * PLOT_H,
      })),
    [series.points, n, plotW, bounds],
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
  const trendUp = series.slopeMsPerRun > 0;

  // Tappable COLUMNS, not dots: a 10px dot is an unreasonable target, and with a
  // dozen runs the dots are closer together than a fingertip anyway. Columns tile
  // the full plot height, so a tap anywhere above or below a point selects it.
  const colW = n > 1 ? Math.max(MIN_TOUCH_W, plotW / (n - 1)) : Math.max(MIN_TOUCH_W, plotW);

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

      <View style={styles.statRow}>
        <Stat label="Best" value={`${formatMs(series.bestMs)}s`} tone="best" />
        <Stat label="Latest" value={`${formatMs(series.latestMs)}s`} />
        <Stat
          label="First → latest"
          value={formatDelta(series.deltaMs)}
          tone={series.deltaMs < -5 ? 'good' : trendUp ? 'bad' : undefined}
        />
      </View>

      <View style={styles.plotRow}>
        <View style={[styles.axis, { width: AXIS_W, height: PLOT_H }]}>
          {ticks.map((t) => (
            <Text
              key={t}
              style={[
                styles.axisLabel,
                { top: yFraction(t, bounds.min, bounds.max) * PLOT_H - 7 },
              ]}
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
                const size = sel === i ? DOT_SEL : DOT;
                return (
                  <View
                    key={p.runId}
                    pointerEvents="none"
                    style={[
                      styles.dot,
                      p.isBest && styles.dotBest,
                      sel === i && styles.dotSel,
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
        {shown ? (
          <Text style={styles.readoutText} numberOfLines={1}>
            <Text style={styles.readoutStrong}>Run {(sel ?? 0) + 1}</Text> · {formatMs(shown.elapsedMs)}s ·{' '}
            {shortDate(shown.createdAt)}
            {shown.isBest ? <Text style={styles.pbTag}>  ★ PB</Text> : null}
          </Text>
        ) : (
          <Text style={styles.readoutHint} numberOfLines={1}>
            Tap a point for the run · ★ marks the best
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
    padding: 14,
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
  plot: { flex: 1, position: 'relative' },
  grid: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#243042',
  },
  guide: { position: 'absolute', top: 0, width: StyleSheet.hairlineWidth, backgroundColor: '#3b82f6' },
  segment: { position: 'absolute', backgroundColor: '#3b82f6', borderRadius: LINE_W / 2 },
  dot: { position: 'absolute', backgroundColor: '#60a5fa', borderWidth: 2, borderColor: '#0e1116' },
  dotBest: { backgroundColor: '#fbbf24' },
  dotSel: { borderColor: '#fff' },
  xAxis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6, paddingRight: PAD_R },
  xLabel: { color: '#475569', fontSize: 10 },
  readout: { minHeight: 34, justifyContent: 'center', marginTop: 8 },
  readoutText: { color: '#cbd5e1', fontSize: 13 },
  readoutStrong: { color: '#fff', fontWeight: '800' },
  readoutHint: { color: '#475569', fontSize: 12 },
  pbTag: { color: '#fbbf24', fontWeight: '800' },
});
