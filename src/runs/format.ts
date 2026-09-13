// Display formatting for a run's attribution. Pure, no imports.
//
// Lived in components/TagPicker until that component was deleted: it was the only
// export still in use there, and leaving it in a file named after a dead modal
// meant the modal kept looking alive.

/** "Jayden · 30m" — joins the non-empty tags; '' if both are empty. */
export function formatTags(name?: string | null, drill?: string | null): string {
  return [name, drill]
    .map((s) => (s ?? '').trim())
    .filter(Boolean)
    .join(' · ');
}

/**
 * A run's mode as a word. The number is the database's and the protocol's — M1,
 * M2 — and it was printed as-is on every History row. A coach reads "Timer" and
 * "Video" and knows which screen a run came from; "M5" told them nothing.
 *
 * Pure and numeric on purpose: importing the mode constants from three engine
 * modules into a formatting helper would drag the BLE layer in with them. The
 * values are pinned by verify-labels against those constants instead.
 */
export function modeLabel(mode: number): string {
  switch (mode) {
    case 1:
      return 'Timer';
    case 2:
      return 'Reaction';
    case 3:
      return 'Drill';
    case 4:
      return 'Laps';
    case 5:
      return 'Video';
    default:
      return `M${mode}`;
  }
}
