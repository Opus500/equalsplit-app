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
