// How a timing screen is arranged, by the shape of the screen it is on.
//
// Both Timer screens are the same three things — the strips at the top (gate,
// lineup, discard, drill), a stage with the number in it, and the controls — and
// both used to arrange them the same way: a column with the stage taking the
// leftover height. On a phone that is right. On a 13-inch iPad it is a number
// floating in a band of nothing, and the first attempt at fixing it (a bigger
// number, still centred) was the same picture with a bigger number.
//
// ONE FRAME, so the two screens cannot drift. The experimental Timer had been
// given the inset and nothing else, and on a Simulator with the engine toggle
// on it was the screen being looked at — "the lineup that fixed Modes isn't on
// Timer" was this file not existing yet. Modes lays itself out inside a
// ScrollView and keeps its own arrangement, but it reads the same column widths
// and the same readoutSize, so the number is one size on both tabs.
//
//   phone            column: strips, stage (flex: 1), controls
//   wide, upright    a capped column: strips, stage (as tall as its number),
//                    the LINEUP scrolling in the rest of the height, controls
//   wide, landscape  two columns under the wider cap: strips, stage and
//                    controls on the left (55%); the lineup on the right, full
//                    height. The strips live in the left column, not across
//                    the top — a 1150pt drill row with the name at one end and
//                    its clear button at the other is not a row, it is a gap.

import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { LineupList } from './LineupList';
import {
  COLUMN_GAP,
  COLUMN_MAX_WIDTH,
  LANDSCAPE_MAX_WIDTH,
  topPad,
  useLayout,
} from '../layout';

export function TimerFrame({
  strips,
  stage,
  controls,
  /** Rendered last, outside the arrangement: the screen's modals. */
  children,
}: {
  strips: ReactNode;
  /** The contents of the stage — the number and what sits under it. The frame
   *  owns the stage box itself, because whether it fills or fits is the frame's
   *  decision. */
  stage: ReactNode;
  controls: ReactNode;
  children?: ReactNode;
}) {
  const { wide, landscape, insets } = useLayout();
  const pad = { paddingTop: topPad(insets) };

  if (!wide) {
    return (
      <View style={[styles.container, pad]}>
        {strips}
        <View style={styles.stage}>{stage}</View>
        {controls}
        {children}
      </View>
    );
  }

  if (!landscape) {
    return (
      <View style={[styles.container, pad, styles.containerWide]}>
        {strips}
        <View style={[styles.stage, styles.stageNatural]}>{stage}</View>
        <LineupList style={styles.lineupBelow} />
        {controls}
        {children}
      </View>
    );
  }

  return (
    <View style={[styles.container, pad, styles.containerLand]}>
      <View style={styles.row}>
        <View style={styles.mainCol}>
          {strips}
          <View style={styles.stage}>{stage}</View>
          {controls}
        </View>
        <LineupList style={styles.sideCol} />
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0e1116', paddingHorizontal: 16 },
  containerWide: { width: '100%', maxWidth: COLUMN_MAX_WIDTH, alignSelf: 'center' },
  containerLand: { width: '100%', maxWidth: LANDSCAPE_MAX_WIDTH, alignSelf: 'center' },
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  // Upright on a wide screen the stage is as tall as its readout and no taller;
  // the lineup takes the height.
  stageNatural: { flex: 0, paddingVertical: 16 },
  // Under the readout, taking the rest of the height, scrolling inside itself.
  lineupBelow: { flex: 1, marginTop: 4, marginBottom: 12, minHeight: 120 },
  row: { flex: 1, flexDirection: 'row', gap: COLUMN_GAP, alignItems: 'stretch' },
  mainCol: { flex: 55 },
  sideCol: { flex: 45, marginBottom: 12 },
});
