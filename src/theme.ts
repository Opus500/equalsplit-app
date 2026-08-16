// The app's colour vocabulary, named by JOB rather than by hue.
//
// Screens import the job. Nothing imports a hex.
//
// THE RULE: every colour that carries meaning carries exactly one meaning, and two
// unrelated facts never share one. Anything that is not one of the six jobs below
// is NEUTRAL — and that rule does most of the work, because the commonest way a
// palette rots is a colour being spent on something that did not need one.
//
// It rotted here first. Picked per screen and by feel, amber ended up carrying
// thirteen unrelated meanings across fifteen files and emerald nine; "personal
// best" was amber on the chart and green in the run list directly beneath it, and
// the same amber said BACKDATED four rows further down. Every one of those was a
// locally reasonable choice made without asking what the colour already meant.
//
// So the guard is not this file. It is scripts/verify-theme.mjs, which fails if a
// semantic hex appears as a literal anywhere in src/, and fails if two jobs are
// given the same value. A colour picked by NAME cannot be picked by feel, and a new
// tag has to answer "which of the six is this?" before it can be written at all.

// --------------------------------------------------------------- the six jobs

/**
 * The number is a personal best.
 *
 * GOLD, because gold-for-best is close to universal in sport and this is a
 * coaching app — going against it would cost recognition for nothing. Deliberately
 * ONE claim: not "good", not "finished", not "improving". A run either is the best
 * or it is not, and everything else that felt like good news has been demoted to
 * neutral, which is why this reads as strongly as it does.
 */
export const ACHIEVEMENT = '#fbbf24';

/**
 * Look at this before you rely on it.
 *
 * A measurement that is less trustworthy than it looks, or a decision the app
 * cannot make. The adjacency with ACHIEVEMENT is the weakest point in this scheme —
 * gold and orange are fifteen degrees apart — and it is accepted because the two
 * almost never share a row: a personal best is by construction not a suspect one.
 */
export const CAUTION = '#fb923c';

/**
 * How the time was produced, when it was not a gate.
 *
 * Provenance of the MEASUREMENT. A gate carries no colour at all — it is the
 * baseline everything else is compared against — which is what keeps this rare
 * enough to notice.
 */
export const METHOD = '#a78bfa';

/**
 * A person edited this record.
 *
 * Provenance of the DATA: the row is not simply what the app wrote when it
 * happened. Backdated runs, unlinked legacy text, archived athletes.
 *
 * Magenta because it was the only clean hue gap left — everything nearer sits on
 * top of blue, violet or gold. Unusual for a coaching app, and that is acceptable
 * when it is the only thing in the app meaning "someone changed this".
 *
 * Moved off #f472b6, which was the first proposal and sat 31 degrees from
 * DESTRUCTIVE — inside the separation this scheme requires of every other pair, and
 * caught by verify-theme rather than by eye. 313 degrees clears both the red at 0
 * and the violet at 255 with room to spare.
 */
export const EDITED = '#e879d0';

/** This destroys something. Text and borders; see DESTRUCTIVE_EDGE/FILL for the
 *  button weights. One red, so "delete" cannot read as two different acts. */
export const DESTRUCTIVE = '#f87171';
export const DESTRUCTIVE_EDGE = '#7f1d1d';
export const DESTRUCTIVE_FILL = '#1a1214';

/**
 * You can tap it — and the data itself.
 *
 * A ramp rather than a single value, because it spans a chart line, a dot, a
 * pressed state and a primary button fill. One job, several weights.
 */
export const INTERACTIVE = '#60a5fa';
export const INTERACTIVE_STRONG = '#3b82f6';
export const INTERACTIVE_SOFT = '#93c5fd';
export const INTERACTIVE_FILL = '#1d4ed8';
export const INTERACTIVE_ON_BG = '#12203a';

/**
 * Live hardware state — and FORM, not just hue.
 *
 * A gate that is armed or busy is a fact about a DEVICE, not about a run, so it
 * would collide with ACHIEVEMENT and CAUTION the moment they shared a screen.
 * Green and orange survive here on the condition that they appear only as filled
 * indicator dots and Go-button fills, never as the colour of text describing a run.
 * The channel is separated by shape rather than by hue.
 */
export const LIVE = '#22c55e';
export const LIVE_BUSY = '#f59e0b';
export const LIVE_FILL = '#16a34a';

// ------------------------------------------------------------------ neutrals
//
// Where everything that does not answer one of the six questions goes. Emphasis
// lives here: INK is loud enough to carry the running phase and the finished timer
// without either of them borrowing a meaning they do not have.

export const INK = '#e2e8f0';
export const INK_BRIGHT = '#ffffff';
export const INK_2 = '#cbd5e1';
export const MUTED = '#94a3b8';
export const FAINT = '#64748b';
export const FAINTER = '#475569';

export const GROUND = '#0e1116';
export const SURFACE = '#161b22';
export const SURFACE_2 = '#131a24';
export const SUNKEN = '#0b0e13';
export const LINE = '#243042';

/**
 * Measurement accuracy, as information rather than warning.
 *
 * Left as it was. Two uses, one meaning, no collision — the audit found nothing
 * wrong with it, and recolouring something that already obeys the rule is churn.
 */
export const ACCURACY = '#38bdf8';
