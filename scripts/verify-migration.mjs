// Rehearse the roster migration against a COPY of a real device database.
//
//   node scripts/verify-migration.mjs <path-to-copy-of-equalsplit.db>
//   node scripts/verify-migration.mjs --demo     # synthetic messy DB, no device needed
//
// It imports src/db/migrations.ts DIRECTLY (Node 24 strips TS types natively),
// so this runs THE SAME migration code the app runs — not a reimplementation
// that could drift. Requires Node >= 22.6 for type stripping; Node 24 needs no
// flag. Zero npm dependencies (node:sqlite is built in).
//
// It never touches your device. Work on a copy — see the pull instructions in
// docs/ROSTER.md; remember to copy the -wal and -shm files too (the DB is in WAL
// mode, so the newest runs may live in the -wal file, not the .db).

import { DatabaseSync } from 'node:sqlite';
import { existsSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const migrations = await import(new URL('../src/db/migrations.ts', import.meta.url).href);
const { runMigrations, foldName, SCHEMA_VERSION } = migrations;

// The progression screen's threshold, imported rather than restated, so the density
// this reports is measured against the number the UI actually enforces.
const { MIN_SERIES_RUNS } = await import(
  new URL('../src/roster/progression.ts', import.meta.url).href
);

// --- node:sqlite -> MigrationDb adapter (mirrors the expo one in database.ts) --
function adapt(db) {
  return {
    execAsync: async (sql) => {
      db.exec(sql);
    },
    getAllAsync: async (sql, params = []) => db.prepare(sql).all(...params),
    getFirstAsync: async (sql, params = []) => db.prepare(sql).get(...params) ?? null,
    runAsync: async (sql, params = []) => db.prepare(sql).run(...params),
  };
}

const has = (db, table) =>
  !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
const count = (db, sql) => {
  try {
    return db.prepare(sql).get()?.c ?? 0;
  } catch {
    return 0;
  }
};

function snapshot(db, label) {
  const runsTotal = count(db, 'SELECT COUNT(*) AS c FROM runs');
  const tagged = count(
    db,
    "SELECT COUNT(*) AS c FROM runs WHERE athlete_name IS NOT NULL AND TRIM(athlete_name) <> ''",
  );
  const athletes = has(db, 'athletes') ? count(db, 'SELECT COUNT(*) AS c FROM athletes') : null;
  const linked = has(db, 'runs')
    ? (() => {
        try {
          return count(db, 'SELECT COUNT(*) AS c FROM runs WHERE athlete_id IS NOT NULL');
        } catch {
          return null;
        }
      })()
    : null;
  const version =
    db.prepare("SELECT value FROM settings WHERE key='schema_version'").get()?.value ?? '0';
  const drills = has(db, 'drills') ? count(db, 'SELECT COUNT(*) AS c FROM drills') : null;
  const drillLinked = (() => {
    try {
      return count(db, 'SELECT COUNT(*) AS c FROM runs WHERE drill_id IS NOT NULL');
    } catch {
      return null;
    }
  })();

  console.log(`\n--- ${label} ---`);
  console.log(`schema_version      : ${version}`);
  console.log(`runs (total)        : ${runsTotal}`);
  console.log(`runs w/ legacy tag  : ${tagged}`);
  console.log(`athletes table      : ${athletes === null ? '(does not exist)' : athletes}`);
  console.log(`runs linked by id   : ${linked === null ? '(no athlete_id column)' : linked}`);
  console.log(`drills table        : ${drills === null ? '(does not exist)' : drills}`);
  console.log(`runs linked to drill: ${drillLinked === null ? '(no drill_id column)' : drillLinked}`);

  // distinct folded names = the number of athletes the backfill SHOULD produce
  if (tagged > 0) {
    const names = db
      .prepare(
        "SELECT athlete_name FROM runs WHERE athlete_name IS NOT NULL AND TRIM(athlete_name) <> ''",
      )
      .all()
      .map((r) => r.athlete_name);
    const folded = new Set(names.map(foldName));
    const raw = new Set(names.map((n) => n.trim()));
    console.log(`distinct tags (raw) : ${raw.size}`);
    console.log(`distinct (folded)   : ${folded.size}  <- expected athlete count from runs`);
  }
  return { runsTotal, tagged, athletes, linked };
}

// --- synthetic legacy database, for --demo ------------------------------------
function buildDemo(file) {
  if (existsSync(file)) rmSync(file);
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL,
      created_at INTEGER NOT NULL, custom_name TEXT, synced INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE runs (id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL,
      mode INTEGER NOT NULL, run_index INTEGER NOT NULL, started_at INTEGER NOT NULL,
      total_ms INTEGER NOT NULL, split1_ms INTEGER NOT NULL, split2_ms INTEGER NOT NULL,
      status TEXT NOT NULL, raw_json TEXT, created_at INTEGER NOT NULL,
      reaction_offset_ms INTEGER NOT NULL DEFAULT 0, athlete_name TEXT, drill_type TEXT,
      synced INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
    INSERT INTO sessions VALUES ('s1','2026-07-28',1000,NULL,0);
  `);
  const ins = db.prepare(
    `INSERT INTO runs (id,session_id,mode,run_index,started_at,total_ms,split1_ms,split2_ms,
       status,raw_json,created_at,reaction_offset_ms,athlete_name,drill_type,synced)
     VALUES (?,?,1,?,?,?,0,0,'valid',NULL,?,0,?,?,0)`,
  );
  // Deliberately messy: case variants, padding, composed vs decomposed accents,
  // an empty string, a NULL, and one clean name.
  //
  // Note the shape of the Jayden/Jose groups: the MOST RECENT spelling is the
  // shouty one, but it is the LEAST used. Canonical = most frequent (ties ->
  // most recent), so a caps-lock session must NOT win the name. That is the
  // regression this fixture exists to catch.
  //
  // Built from char codes, never literals: composed e-acute (U+00E9) and
  // decomposed e + combining acute (U+0065 U+0301) RENDER IDENTICALLY, so a
  // source literal is indistinguishable to a reader and editors silently
  // normalize one into the other -- which would quietly delete the very case
  // this fixture exists to prove (folding on NFC).
  const E_ACUTE = String.fromCharCode(0x00e9); // composed   e-acute
  const COMBINING_ACUTE = String.fromCharCode(0x0301); // combining accent
  const E_ACUTE_CAPS = String.fromCharCode(0x00c9); // composed   E-acute
  const JOSE_COMPOSED = 'Jos' + E_ACUTE;
  const JOSE_DECOMPOSED = 'Jose' + COMBINING_ACUTE;
  const JOSE_SHOUTED = 'JOS' + E_ACUTE_CAPS;
  const rows = [
    ['r1', 1, 4210, 1000, 'Jayden', '30m'],
    ['r2', 2, 4180, 2000, 'Jayden', '30m'],
    ['r3', 3, 4300, 3000, '  jayden  ', '30M'], // padded name + SHOUTED drill
    ['r4', 4, 4260, 4000, 'JAYDEN', '30m'], // most RECENT, least FREQUENT
    ['r5', 5, 5010, 5000, JOSE_COMPOSED, ' 30m '], // padded drill -> same drill
    ['r6', 6, 4990, 6000, JOSE_DECOMPOSED, '30m'], // identical on screen
    ['r7', 7, 5100, 7000, JOSE_COMPOSED, '30m'], // -> composed is most frequent
    ['r8', 8, 5050, 8000, JOSE_SHOUTED, '30m'], // most RECENT, least FREQUENT
    ['r9', 9, 3900, 9000, 'Mia', 'L Drill'],
    ['r10', 10, 3950, 10000, '', 'L Drill'], // empty -> stays unassigned
    ['r11', 11, 4000, 11000, null, 'L Drill'], // null  -> stays unassigned
  ];
  for (const [id, idx, total, at, name, drill] of rows) {
    ins.run(id, 's1', idx, at, total, at, name, drill);
  }
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run(
    'recent_athletes',
    JSON.stringify(['Mia', 'Priya']), // Priya has no runs -> seeded
  );
  db.close();
}

// --- main ---------------------------------------------------------------------
const arg = process.argv[2];
if (!arg) {
  console.error('usage: node scripts/verify-migration.mjs <db-copy> | --demo');
  process.exit(1);
}

let file;
if (arg === '--demo') {
  file = path.join(tmpdir(), 'equalsplit-demo.db');
  buildDemo(file);
  console.log(`demo database built at ${file}`);
} else {
  file = path.resolve(arg);
  if (!existsSync(file)) {
    console.error(`no such file: ${file}`);
    process.exit(1);
  }
  // Always operate on our own copy so the file you pulled stays pristine.
  const work = `${file}.verify.db`;
  copyFileSync(file, work);
  for (const ext of ['-wal', '-shm']) {
    if (existsSync(file + ext)) copyFileSync(file + ext, work + ext);
  }
  console.log(`working on a copy: ${work}`);
  file = work;
}

const db = new DatabaseSync(file);
const before = snapshot(db, 'BEFORE');

const report = await runMigrations(adapt(db));

console.log('\n--- MIGRATION REPORT ---');
console.log(JSON.stringify(report, null, 2));

const after = snapshot(db, 'AFTER');

if (report.merges.length) {
  console.log('\n--- NAME MERGES (case/accent variants folded into one athlete) ---');
  for (const m of report.merges) {
    console.log(`  "${m.display}"  <=  ${m.variants.map((v) => JSON.stringify(v)).join(', ')}  (${m.runs} runs)`);
  }
}

console.log('\n--- ATHLETES AFTER MIGRATION ---');
for (const a of db
  .prepare(
    `SELECT a.display_name, a.group_name, a.archived_at,
            (SELECT COUNT(*) FROM runs r WHERE r.athlete_id = a.id) AS runs
       FROM athletes a ORDER BY a.created_at ASC`,
  )
  .all()) {
  console.log(
    `  ${a.display_name.padEnd(18)} runs=${String(a.runs).padEnd(3)} group=${a.group_name ?? '-'} ${a.archived_at ? '(archived)' : ''}`,
  );
}

if (report.drillMerges.length) {
  console.log('\n--- DRILL MERGES (case/padding variants folded into one drill) ---');
  for (const m of report.drillMerges) {
    console.log(`  "${m.display}"  <=  ${m.variants.map((v) => JSON.stringify(v)).join(', ')}  (${m.runs} runs)`);
  }
}

console.log('\n--- DRILLS AFTER MIGRATION ---');
for (const d of db
  .prepare(
    `SELECT d.name, d.kind, d.last_used_at,
            (SELECT COUNT(*) FROM runs r WHERE r.drill_id = d.id) AS runs
       FROM drills d ORDER BY d.last_used_at IS NULL, d.last_used_at DESC`,
  )
  .all()) {
  console.log(
    `  ${d.name.padEnd(14)} runs=${String(d.runs).padEnd(3)} kind=${d.kind.padEnd(7)}${d.last_used_at ? '' : ' (never used — sinks in the picker)'}`,
  );
}

// What the progression graph can ACTUALLY draw. A run only reaches a chart if it
// has BOTH an athlete and a drill record, so this is the intersection, not either
// count on its own — and it is the honest answer to "will this screen be empty?".
console.log(`\n--- SERIES DENSITY (progression graph needs ${MIN_SERIES_RUNS}+ runs per athlete per drill) ---`);
{
  const series = db
    .prepare(
      `SELECT a.display_name AS athlete, d.name AS drill, COUNT(*) AS runs
         FROM runs r
         JOIN athletes a ON a.id = r.athlete_id
         JOIN drills   d ON d.id = r.drill_id
        WHERE r.athlete_id IS NOT NULL AND r.drill_id IS NOT NULL
        GROUP BY r.athlete_id, r.drill_id
        ORDER BY runs DESC, a.display_name ASC`,
    )
    .all();

  if (!series.length) {
    console.log('  (none — no run has both an athlete and a drill)');
  } else {
    for (const s of series) {
      const ok = s.runs >= MIN_SERIES_RUNS;
      console.log(
        `  ${String(s.athlete).padEnd(16)} ${String(s.drill).padEnd(14)} ${String(s.runs).padStart(3)} runs   ${
          ok ? 'GRAPH' : `too thin (needs ${MIN_SERIES_RUNS - s.runs} more)`
        }`,
      );
    }
  }

  const graphable = series.filter((s) => s.runs >= MIN_SERIES_RUNS);
  const athletesWithGraph = new Set(graphable.map((s) => s.athlete)).size;
  const bothLinked = count(
    db,
    'SELECT COUNT(*) AS c FROM runs WHERE athlete_id IS NOT NULL AND drill_id IS NOT NULL',
  );
  const total = count(db, 'SELECT COUNT(*) AS c FROM runs');
  console.log(
    `\n  ${graphable.length}/${series.length} series meet the threshold; ${athletesWithGraph} athlete(s) would see a chart.`,
  );
  console.log(
    `  ${bothLinked}/${total} runs are chartable at all (need an athlete AND a drill); ${total - bothLinked} are missing one or both.`,
  );
  if (!graphable.length) {
    console.log(
      '  NOTE: every athlete would see "not enough data yet". Not a bug — the data is thin,\n' +
        '        and the screen should say so plainly rather than draw a chart from two points.',
    );
  }
}

// Idempotency: initDb() runs at every app launch, so a second pass MUST be inert.
const second = await runMigrations(adapt(db));
console.log('\n--- IDEMPOTENCY CHECK (second run, as on next app launch) ---');
console.log(
  `  ranBackfill=${second.ranBackfill} (expect false)  athletesCreated=${second.athletesCreated} (expect 0)  runsLinked=${second.runsLinked} (expect 0)  drillsCreated=${second.drillsCreated} (expect 0)`,
);

// The upgrade path this device will ACTUALLY take: it is already at v2, so only
// the drill step may run. Re-running the athlete step would resurrect links the
// coach had deliberately cleared — the exact hazard the version gate exists for.
console.log('\n--- v2 -> v3 UPGRADE PATH (what an already-migrated phone does) ---');
db.exec("UPDATE settings SET value='2' WHERE key='schema_version'");
db.exec('DELETE FROM drills');
db.exec('UPDATE runs SET drill_id = NULL');
const athletesBeforeStep = db.prepare('SELECT COUNT(*) AS c FROM athletes').get().c;
const linksBeforeStep = db.prepare(
  'SELECT COUNT(*) AS c FROM runs WHERE athlete_id IS NOT NULL',
).get().c;
const upgrade = await runMigrations(adapt(db));
const athletesAfterStep = db.prepare('SELECT COUNT(*) AS c FROM athletes').get().c;
const linksAfterStep = db.prepare(
  'SELECT COUNT(*) AS c FROM runs WHERE athlete_id IS NOT NULL',
).get().c;
console.log(
  `  athletesCreated=${upgrade.athletesCreated} (expect 0)  drillsCreated=${upgrade.drillsCreated} (expect >0)  drillRunsLinked=${upgrade.drillRunsLinked}`,
);
console.log(
  `  athletes ${athletesBeforeStep} -> ${athletesAfterStep} (unchanged)   athlete links ${linksBeforeStep} -> ${linksAfterStep} (unchanged)`,
);

const athletesAfter = db.prepare('SELECT COUNT(*) AS c FROM athletes').get().c;
const stillTagged = before.tagged;
const linkedAfter = after.linked;
const drillTagged = count(
  db,
  "SELECT COUNT(*) AS c FROM runs WHERE drill_type IS NOT NULL AND TRIM(drill_type) <> ''",
);
const drillLinkedAfter = count(db, 'SELECT COUNT(*) AS c FROM runs WHERE drill_id IS NOT NULL');

const problems = [];
if (second.ranBackfill || second.athletesCreated || second.runsLinked || second.drillsCreated)
  problems.push('second run was NOT inert — the version gate is broken');
if (upgrade.athletesCreated !== 0 || athletesAfterStep !== athletesBeforeStep)
  problems.push('v2->v3 re-ran the ATHLETE backfill — steps are not separately gated');
if (linksAfterStep !== linksBeforeStep)
  problems.push('v2->v3 altered existing athlete links');
if (upgrade.drillsCreated === 0) problems.push('v2->v3 did not create drills');
if (drillLinkedAfter !== drillTagged)
  problems.push(`drill-linked ${drillLinkedAfter} != ${drillTagged} runs that had a drill label`);
if (linkedAfter !== stillTagged)
  problems.push(`linked ${linkedAfter} != ${stillTagged} runs that had a tag`);
if (after.runsTotal !== before.runsTotal)
  problems.push(`run count changed: ${before.runsTotal} -> ${after.runsTotal}`);
if (report.toVersion !== SCHEMA_VERSION) problems.push('schema_version not stamped');

console.log('\n=============================');
if (problems.length) {
  console.log('RESULT: PROBLEMS FOUND');
  for (const p of problems) console.log(`  ! ${p}`);
  process.exitCode = 1;
} else {
  console.log(
    `RESULT: OK — ${before.runsTotal} runs preserved, ${stillTagged} relinked to ${athletesAfter} athletes, no data lost.`,
  );
}
db.close();
