// One flat list of every drill the app can time, for a single picker.
//
// Derived from the engine modules rather than restated, so adding a drill to
// DRILLS or REPEATS puts it in the picker with no second edit — which is the
// point of replacing the segmented switch: a switch does not scale, a list does.
//
// Pure, verified by scripts/verify-catalog.mjs. In particular resolveKey() is what
// makes DrillsScreen's uncontrolled path a genuine no-op: with no `selectedKey`
// the screen falls back to its own state exactly as before.

import { DRILLS } from './drills';
import { REPEATS } from './repeats';

/** Which engine owns this drill — and therefore which screen renders it. */
export type CatalogKind = 'counted' | 'repeat';

export type CatalogEntry = {
  key: string;
  title: string;
  kind: CatalogKind;
  /** one line under the title in the picker, so the choice is legible cold */
  blurb: string;
};

const BLURBS: Record<string, string> = {
  'l-drill': 'Two gates · start on gate 1, finish on gate 2',
  shuttle: 'One gate · two crossings',
  'repeat-continuous': 'One gate · laps, gate-timed both ends',
  'repeat-rest': 'One gate · tap each rep, saved as its own run',
};

/** Counted drills first, then rep sets — oldest and most-used at the top. */
export const DRILL_CATALOG: CatalogEntry[] = [
  ...DRILLS.map((d) => ({
    key: d.key,
    title: d.label,
    kind: 'counted' as const,
    blurb: BLURBS[d.key] ?? '',
  })),
  ...REPEATS.map((r) => ({
    key: r.key,
    title: r.title,
    kind: 'repeat' as const,
    blurb: BLURBS[r.key] ?? '',
  })),
];

export function entryFor(key: string): CatalogEntry | null {
  return DRILL_CATALOG.find((e) => e.key === key) ?? null;
}

export function kindFor(key: string): CatalogKind | null {
  return entryFor(key)?.kind ?? null;
}

/**
 * Which drill key is active.
 *
 * `selected` absent (or null) means nobody is controlling the screen from
 * outside, so the caller's own state wins — this is the property that keeps
 * DrillsScreen behaving exactly as it did before the prop existed.
 */
export function resolveKey(selected: string | null | undefined, fallback: string): string {
  return selected ?? fallback;
}
