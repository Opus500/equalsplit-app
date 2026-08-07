// Plain-text formatting + the native share sheet (RN core Share — no extra native
// module, so it works in the current dev client; the iOS sheet also offers Copy).

import { Share } from 'react-native';
import { formatTags } from './components/TagPicker';

const secs = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(2)}s`;

/** One run as "Jayden · 30m · 4.21s" (empty tags omitted; time always shown). */
export function runShareLine(
  athlete: string | null | undefined,
  drill: string | null | undefined,
  totalMs: number,
): string {
  return [formatTags(athlete, drill), secs(totalMs)].filter(Boolean).join(' · ');
}

/** One run, already resolved for display. Deliberately NOT a RunRow: share text
 *  must never read the raw `athlete_name` snapshot, which is frozen at save time
 *  and goes stale the moment an athlete is renamed. Callers resolve through
 *  resolvedAthlete() so shared text, History and the timer always agree. */
export type ShareRun = {
  athleteName: string | null;
  drillType: string | null;
  totalMs: number;
};

/** A whole session: a header line (name, with the date in parens if renamed)
 *  followed by one run per line. Pass runs in the order you want them listed. */
export function sessionShareText(title: string, dateName: string, runs: ShareRun[]): string {
  const header = title.trim() && title.trim() !== dateName ? `${title.trim()} (${dateName})` : dateName;
  const lines = runs.map((r) => runShareLine(r.athleteName, r.drillType, r.totalMs));
  return [header, ...lines].join('\n');
}

/** Open the native share sheet; silently ignores cancel/unavailable. */
export async function shareText(message: string): Promise<void> {
  try {
    await Share.share({ message });
  } catch {
    /* cancelled or unavailable */
  }
}
