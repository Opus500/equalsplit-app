// Duplicate-name disambiguation — PURE (foldName is itself import-free), so the
// rule can be executed in scripts/verify-labels.mjs.
//
// Requirement: two athletes with the same display name must be distinguishable
// in EVERY picker and list. That only holds if one function decides it, so this
// is the single source and every list renders `detail` beneath the name.
//
// Priority is deliberate: the coach's OWN words first (group_name, prompted for
// at creation), and the added-date/id suffix only as a last resort — a row
// reading "Jayden · added Jul 30 · #a4f2" is unreadable mid-practice and is
// there to guarantee uniqueness, not to be used.

import { foldName } from '../db/migrations';

export type LabelableAthlete = {
  id: string;
  display_name: string;
  group_name: string | null;
  created_at: number;
};

const shortId = (id: string) => id.slice(-4);

function shortDate(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/**
 * Map of athlete id -> secondary detail line, or null when the display name is
 * already unambiguous *within the list being rendered*.
 *
 * Call it with exactly the list you are about to show: hiding archived athletes
 * removes them as a source of ambiguity, so a picker shouldn't carry clutter
 * caused by someone who isn't in it.
 */
export function disambiguate(list: LabelableAthlete[]): Map<string, string | null> {
  const buckets = new Map<string, LabelableAthlete[]>();
  for (const a of list) {
    const key = foldName(a.display_name);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(a);
    else buckets.set(key, [a]);
  }

  const out = new Map<string, string | null>();
  for (const bucket of buckets.values()) {
    if (bucket.length === 1) {
      out.set(bucket[0].id, null);
      continue;
    }
    // Coach's words if they gave any, otherwise when they were added.
    const base = new Map<string, string>();
    const uses = new Map<string, number>();
    for (const a of bucket) {
      const detail = (a.group_name ?? '').trim() || `added ${shortDate(a.created_at)}`;
      base.set(a.id, detail);
      uses.set(detail, (uses.get(detail) ?? 0) + 1);
    }
    // Still colliding (same group, or added the same day) -> append the id,
    // which is the only thing guaranteed to differ.
    for (const a of bucket) {
      const detail = base.get(a.id) ?? '';
      out.set(a.id, (uses.get(detail) ?? 0) > 1 ? `${detail} · #${shortId(a.id)}` : detail);
    }
  }
  return out;
}

/** "12 runs" / "1 run" / "no runs yet" — athletes seeded from recents have zero
 *  runs and are perfectly normal, so lists must never assume history exists. */
export function runCountLabel(n: number): string {
  if (n <= 0) return 'no runs yet';
  return `${n} run${n === 1 ? '' : 's'}`;
}
