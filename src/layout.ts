// The one place that decides what the screen is.
//
// Every screen was laid out for one shape: a phone, upright, with a Dynamic
// Island. On a 13-inch iPad the same code renders phone-proportioned content
// stretched across 1032pt with the readout at phone size and the Arm button a
// metre wide, and opens each screen with a 32pt dead band where the island
// would have been. This hook is what a screen asks instead of assuming.
//
// TWO FACTS, not a device check. `wide` is width, because that is what decides
// whether a column should be capped or a number scaled — an iPad in a one-third
// split is a phone for layout purposes and gets the phone layout by construction.
// `landscape` is the aspect. Neither is "isPad": the layout code never needs to
// know what the hardware is, only how much of it there is.
//
// The insets come from react-native-safe-area-context rather than numbers. The
// 56pt top padding the screens carried was a Dynamic Island phone's value written
// down; it was 32pt too much on an iPad and would be 56pt of nothing in landscape.

import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets, type EdgeInsets } from 'react-native-safe-area-context';

/**
 * Below this width the phone layout applies unchanged. 700 sits between the
 * widest phone (430pt upright) and the narrowest iPad in full screen (744pt, the
 * mini), and above any iPad split narrower than half.
 */
export const WIDE_MIN_WIDTH = 700;

/** How much wider than a phone a column may grow before it is capped. */
export const COLUMN_MAX_WIDTH = 680;

/** The cap for a two-column landscape layout: the readout beside the lineup. */
export const LANDSCAPE_MAX_WIDTH = 1180;

/** How the two landscape columns split the width. The readout side is the
 *  larger, because the number is what the screen is for. */
export const MAIN_COLUMN_SHARE = 0.55;

/** Side padding every screen carries. */
const SCREEN_PAD = 16;
/** The gap between the two landscape columns. */
export const COLUMN_GAP = 16;

export type Layout = {
  width: number;
  height: number;
  /** Wide enough that phone layout would read as stretched. */
  wide: boolean;
  landscape: boolean;
  insets: EdgeInsets;
};

export function useLayout(): Layout {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  return {
    width,
    height,
    wide: width >= WIDE_MIN_WIDTH,
    landscape: width > height,
    insets,
  };
}

/**
 * The padding a screen puts above its title. The inset, plus enough that the
 * title does not crowd the clock — the same gap on every screen.
 *
 * 16, not 6: at 6 the titles sat against the status bar on an iPad in both
 * orientations (its status bar stays up in landscape, so the inset does not
 * change and neither did the crowding). A navigation bar puts about this much
 * air under the clock before its title.
 */
export function topPad(insets: EdgeInsets, extra = 16): number {
  return insets.top + extra;
}

/**
 * The readout's font size for a column of the given width, on a wide screen.
 *
 * FITTED, not merely enlarged. A fixed 128pt centred in a 900pt stage was the
 * phone's number with more air around it, which is not what a wide screen is
 * for. "88.888" in tabular 800-weight digits is about 3.7em wide, so width / 4.1
 * fills roughly nine-tenths of the column; the ceiling stops a 13-inch landscape
 * column producing a number taller than the space above and below it can hold.
 * Phones never call this: their readouts keep their fixed sizes.
 */
export function readoutSize(columnWidth: number): number {
  return Math.max(96, Math.min(184, Math.floor(columnWidth / 4.1)));
}

/**
 * The width the readout's column actually has on a wide screen: the capped
 * column less the screen padding upright, or the larger of the two landscape
 * columns. What readoutSize is fed, so the number and the column agree.
 */
export function mainColumnWidth({ width, landscape }: Pick<Layout, 'width' | 'landscape'>): number {
  if (!landscape) return Math.min(width, COLUMN_MAX_WIDTH) - SCREEN_PAD * 2;
  return Math.floor(
    (Math.min(width, LANDSCAPE_MAX_WIDTH) - SCREEN_PAD * 2 - COLUMN_GAP) * MAIN_COLUMN_SHARE,
  );
}

/**
 * The tab bar's bottom padding. The inset, capped at what the bar used to have:
 * a phone with a home indicator keeps its 24pt, an iPad gets its 20, and a phone
 * with a home button gets none of the dead space it used to carry.
 */
export function tabBarBottomPad(insets: EdgeInsets): number {
  return Math.min(insets.bottom, 24);
}
