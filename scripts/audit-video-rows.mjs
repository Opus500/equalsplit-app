// Find video runs whose stored accuracy fields were written by the broken grid
// statistics, before 3eecc9c.
//
//   node scripts/audit-video-rows.mjs <path-to-copy-of-equalsplit.db>
//
// READ-ONLY. It reports; it does not write. If it finds rows, the repair belongs
// in migrations.ts where it can be version-gated and rehearsed — not in a script
// that touches a database by hand.
//
// It never touches your device. Work on a copy, and copy the -wal and -shm files
// too: the DB is in WAL mode, so the newest runs may live in the -wal file rather
// than the .db.
//
// WHAT WENT WRONG. The frame grid is built from separate probed windows with
// unprobed clip between them, and three functions read `frames` as one contiguous
// sequence. Two consequences reached storage:
//
//   fps         came from measuredFps, which divided the frame COUNT by the whole
//               probed SPAN including the gaps. It read low and rose as more of
//               the clip was probed. Descriptive only — nothing computes from it.
//
//   quantSdMs   came from a mark whose frame duration could be measured across an
//               unprobed gap: 9466ms instead of 33.3ms in the reproduction, giving
//               a +/-2733ms error bar. This one is a claim about accuracy, and a
//               wrong one is worse than none.
//
// NOT AFFECTED: total_ms, startPts and endPts. The elapsed time is the difference
// of two real presentation timestamps and was never touched by any of this. No
// run has a wrong TIME.

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

const { VIDEO_MODE } = await import(new URL('../src/video/timing.ts', import.meta.url).href);

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('usage: node scripts/audit-video-rows.mjs <path-to-copy-of-equalsplit.db>');
  process.exit(2);
}
if (!existsSync(dbPath)) {
  console.error(`not found: ${dbPath}`);
  process.exit(2);
}

/**
 * The slowest frame rate a real clip could plausibly have.
 *
 * Derived, not picked: for two frames of equal length the stored sigma is
 * (1000/fps)/sqrt(12) * sqrt(2). At 30fps that is 13.6ms, at 24fps 17.0ms, at
 * 15fps 27.2ms. Nothing anyone films a sprint on records below 10fps, so a sigma
 * above that floor means at least one mark claimed a frame duration no camera
 * produced — which is exactly the cross-gap measurement.
 */
const FLOOR_FPS = 10;
const MAX_PLAUSIBLE_SD_MS = (1000 / FLOOR_FPS) * Math.sqrt(2 / 12);

const db = new DatabaseSync(dbPath, { readOnly: true });

const rows = db
  .prepare(
    `SELECT id, mode, total_ms, created_at, raw_json, athlete_name, drill_type
       FROM runs
      WHERE mode = ?
      ORDER BY created_at ASC`,
  )
  .all(VIDEO_MODE);

console.log(`\n${rows.length} video run(s) (mode ${VIDEO_MODE}) in this database.\n`);

if (!rows.length) {
  console.log('Nothing to audit. No video runs have been saved on this device.\n');
  process.exit(0);
}

const when = (ms) => new Date(ms).toISOString().slice(0, 10);
const suspect = [];
const oddFps = [];

for (const r of rows) {
  let v = null;
  try {
    v = JSON.parse(r.raw_json ?? '');
  } catch {
    v = null;
  }
  if (!v || v.engine !== 'video') continue;

  const sd = Number.isFinite(v.quantSdMs) ? v.quantSdMs : null;
  const fps = Number.isFinite(v.fps) ? v.fps : null;

  if (sd !== null && sd > MAX_PLAUSIBLE_SD_MS) {
    // Reconstruct what frame length that sigma implies, so the number is legible
    // rather than just "too big". With one frame dominating, sd ~ d/sqrt(12).
    suspect.push({ ...r, sd, fps, impliedFrameMs: sd * Math.sqrt(12) });
  }
  // A rate outside this range is not a camera, it is the count-over-span artifact.
  if (fps !== null && (fps < FLOOR_FPS || fps > 1000)) oddFps.push({ ...r, fps });
}

const describe = (r) =>
  `  ${r.id}  ${when(r.created_at)}  ${(r.total_ms / 1000).toFixed(2)}s  ` +
  `${r.athlete_name ?? 'Unassigned'} / ${r.drill_type ?? 'no drill'}`;

console.log('--- ERROR BARS -------------------------------------------------');
console.log(`  plausible ceiling: +/-${MAX_PLAUSIBLE_SD_MS.toFixed(1)}ms (a ${FLOOR_FPS}fps clip)\n`);
if (!suspect.length) {
  console.log('  None. Every stored error bar is one a real clip could produce.');
} else {
  console.log(`  ${suspect.length} run(s) carry an error bar no camera could have produced:`);
  for (const r of suspect) {
    console.log(describe(r));
    console.log(
      `      stored +/-${Math.round(r.sd)}ms  =>  implies a frame ~${Math.round(r.impliedFrameMs)}ms long`,
    );
  }
}

console.log('\n--- RECORDED FRAME RATES ---------------------------------------');
if (!oddFps.length) {
  console.log('  None outside 10-1000fps.');
} else {
  console.log(`  ${oddFps.length} run(s) recorded an impossible frame rate:`);
  for (const r of oddFps) console.log(`${describe(r)}\n      fps = ${r.fps.toFixed(2)}`);
}

console.log('\n--- TIMES ------------------------------------------------------');
console.log('  Unaffected by construction. total_ms is the difference of two real');
console.log('  presentation timestamps; none of the broken statistics touched it.');

const bad = suspect.length + oddFps.length;
console.log('\n=============================');
if (!bad) {
  console.log('RESULT: OK — nothing to clear. No stored row carries a fabricated figure.\n');
} else {
  console.log(`RESULT: ${suspect.length} bad error bar(s), ${oddFps.length} bad frame rate(s).`);
  console.log('These are descriptive fields; no time is wrong, and nothing in the app');
  console.log('reads them back today. Say the word and the repair goes into');
  console.log('migrations.ts, version-gated, dropping the fields rather than');
  console.log('inventing replacements — a missing figure is "not measured", which');
  console.log('is true; a recomputed one would be a second fabrication.\n');
}
db.close();
process.exit(0);
