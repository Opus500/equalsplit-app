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

/** A whole session: a header line (name, with the date in parens if renamed)
 *  followed by one run per line. Pass runs in the order you want them listed. */
export function sessionShareText(
  title: string,
  dateName: string,
  runs: { athlete_name: string | null; drill_type: string | null; total_ms: number }[],
): string {
  const header = title.trim() && title.trim() !== dateName ? `${title.trim()} (${dateName})` : dateName;
  const lines = runs.map((r) => runShareLine(r.athlete_name, r.drill_type, r.total_ms));
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
