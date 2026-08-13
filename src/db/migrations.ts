// Schema + data migrations for the local SQLite database.
//
// DELIBERATELY dependency-free — no expo-sqlite, no React, no imports at all.
// It talks to a tiny async DB interface that BOTH expo-sqlite's SQLiteDatabase
// (in the app, via the adapter in database.ts) and a node:sqlite adapter
// (scripts/verify-migration.mjs) satisfy. That is what lets the roster backfill
// be rehearsed against a real copy of the phone's database before it ever runs
// on the phone — running the SAME code, not a reimplementation that could drift.
//
// Ordering rule: ensureSchema() is idempotent and runs on every launch; the
// one-time DATA backfill is gated on schema_version and runs in a transaction.

export const SCHEMA_VERSION = 3;

/**
 * Drill labels owned by the Drills engine (src/ble/drills.ts DRILLS[].label) and
 * the standalone observer. Duplicated as literals because this module must stay
 * import-free — keep in sync if an engine drill is added. They are marked
 * kind='engine' so the timer's picker can exclude them: a Mode-1 run is never
 * "L Drill", and mixing them would undo the point of trimming that list.
 */
export const ENGINE_DRILL_LABELS = ['L Drill', 'Shuttle Run', 'Standalone'];

/**
 * Seeded vocabulary for the timer's drill picker (kind='manual').
 *
 * "10m start" is a distinct drill from "10m", not a spelling of it, and it is the
 * most-used label on real data. It first appeared only because the v3 backfill
 * minted it from old free-text tags; listing it here makes it a first-class preset
 * so it survives a regenerated preset list instead of depending on that artifact.
 *
 * Seeding is idempotent by FOLDED name (see backfillDrills), so adding a label that
 * a device already created from tags re-uses that record rather than duplicating it.
 */
export const SEED_DRILL_LABELS = ['10m', '10m start', '20m', '30m', '40yd dash'];

/** Which picker a drill belongs to. Engine drills are written by the Drills
 *  screen / standalone observer and must not clutter the timer's list. */
export function drillKindFor(name: string): 'engine' | 'manual' {
  const key = foldName(name);
  return ENGINE_DRILL_LABELS.some((l) => foldName(l) === key) ? 'engine' : 'manual';
}

/** Values SQLite can bind. Matches expo-sqlite's SQLiteBindValue minus blobs. */
export type BindValue = string | number | null | boolean;

export type MigrationDb = {
  execAsync(sql: string): Promise<void>;
  getAllAsync<T>(sql: string, params?: BindValue[]): Promise<T[]>;
  getFirstAsync<T>(sql: string, params?: BindValue[]): Promise<T | null>;
  runAsync(sql: string, params?: BindValue[]): Promise<unknown>;
};

/** Same format as database.ts's ids (base36 time + random). Duplicated rather
 *  than imported because this module must stay free of app-side imports. */
export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Fold a display name to its identity key: trim → NFC-normalize → lowercase.
 *
 * Done in JS, NOT in SQL: SQLite's lower() is ASCII-only, so "JOSÉ" and "josé"
 * would NOT fold in SQL and the coach would end up with two athlete records for
 * one person. NFC normalization additionally merges the same accented name typed
 * on different keyboards (composed vs decomposed forms look identical on screen
 * but are different byte strings).
 */
export function foldName(s: string): string {
  return s.trim().normalize('NFC').toLocaleLowerCase();
}

/**
 * Pick the canonical spelling for a folded name group: MOST FREQUENT wins,
 * ties break to MOST RECENT.
 *
 * Deliberately NOT "most recent spelling": one session typed with caps lock on
 * is a keyboard state, not a naming decision, and it would permanently rename
 * the athlete. Deliberately NOT an uppercase-detection heuristic either — plenty
 * of names legitimately carry caps (McRae, DeAndre, O'Neill), and a rule that
 * "fixes" them is worse than the problem. Frequency is the honest signal: the
 * spelling the coach actually uses is the one they use most.
 */
export function canonicalSpelling(spellings: Map<string, { count: number; lastAt: number }>): string {
  let best = '';
  let bestCount = -1;
  let bestAt = -1;
  for (const [spelling, s] of spellings) {
    if (s.count > bestCount || (s.count === bestCount && s.lastAt > bestAt)) {
      best = spelling;
      bestCount = s.count;
      bestAt = s.lastAt;
    }
  }
  return best;
}

export type MergedGroup = {
  /** the canonical display name chosen (most frequent spelling, ties → most recent) */
  display: string;
  /** every distinct spelling that folded into it */
  variants: string[];
  /** how many runs linked to it */
  runs: number;
};

export type MigrationReport = {
  fromVersion: number;
  toVersion: number;
  ranBackfill: boolean;
  runsTotal: number;
  /** runs carrying a legacy free-text tag, before the backfill */
  runsWithLegacyTag: number;
  athletesCreated: number;
  runsLinked: number;
  /** athletes seeded from settings['recent_athletes'] that had no runs yet */
  seededFromRecents: number;
  /** groups where >1 spelling folded together (the case/accent merges) */
  merges: MergedGroup[];
  /** runs still unlinked after the backfill (legitimately Unassigned) */
  runsUnassignedAfter: number;
  // --- v3: drills ---
  drillsCreated: number;
  drillRunsLinked: number;
  drillMerges: MergedGroup[];
  runsWithoutDrillAfter: number;
};

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export type NameGroup = {
  /** exact spelling (trimmed) -> how often used, and when last used */
  spellings: Map<string, { count: number; lastAt: number }>;
  firstAt: number;
  lastAt: number;
  rowIds: string[];
};

/**
 * Fold rows of {id, name, at} into one group per canonical name. Shared by the
 * athlete and drill backfills so both get identical, already-verified folding
 * (NFC + case) and identical canonical-spelling selection.
 * Rows MUST be ordered by `at` ascending.
 */
export function groupByFoldedName(
  rows: { id: string; name: string | null; at: number }[],
): Map<string, NameGroup> {
  const groups = new Map<string, NameGroup>();
  for (const r of rows) {
    const name = (r.name ?? '').trim();
    if (!name) continue;
    const key = foldName(name);
    let g = groups.get(key);
    if (!g) {
      g = { spellings: new Map(), firstAt: r.at, lastAt: r.at, rowIds: [] };
      groups.set(key, g);
    }
    const s = g.spellings.get(name);
    if (s) {
      s.count += 1;
      if (r.at > s.lastAt) s.lastAt = r.at;
    } else {
      g.spellings.set(name, { count: 1, lastAt: r.at });
    }
    g.rowIds.push(r.id);
    if (r.at < g.firstAt) g.firstAt = r.at;
    if (r.at > g.lastAt) g.lastAt = r.at;
  }
  return groups;
}

async function tableColumns(db: MigrationDb, table: string): Promise<string[]> {
  const cols = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
  return cols.map((c) => c.name);
}

async function getVersion(db: MigrationDb): Promise<number> {
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM settings WHERE key = ?',
    ['schema_version'],
  );
  const n = row ? parseInt(row.value, 10) : 0;
  return Number.isFinite(n) ? n : 0;
}

async function setVersion(db: MigrationDb, v: number): Promise<void> {
  await db.runAsync(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ['schema_version', String(v)],
  );
}

/**
 * Create/extend every table. Idempotent — safe on every launch, and safe on a
 * database created by any previous version of the app.
 */
export async function ensureSchema(db: MigrationDb): Promise<void> {
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      custom_name TEXT,
      synced INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL,
      mode INTEGER NOT NULL,
      run_index INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      total_ms INTEGER NOT NULL,
      split1_ms INTEGER NOT NULL,
      split2_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      raw_json TEXT,
      created_at INTEGER NOT NULL,
      reaction_offset_ms INTEGER NOT NULL DEFAULT 0,
      athlete_name TEXT,
      drill_type TEXT,
      synced INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );

    -- Roster (schema v2). Athletes are ARCHIVED, never deleted: archived_at is a
    -- timestamp (not a boolean) so we keep when it happened, and it indexes as
    -- cheaply. group_name is free text — no fixed vocabulary — and doubles as the
    -- coach-authored disambiguator for two athletes with the same display name.
    CREATE TABLE IF NOT EXISTS athletes (
      id TEXT PRIMARY KEY NOT NULL,
      display_name TEXT NOT NULL,
      group_name TEXT,
      created_at INTEGER NOT NULL,
      archived_at INTEGER,
      synced INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_athletes_archived ON athletes(archived_at);

    -- Drills (schema v3). Records, not free text, for the same reason athletes
    -- are: "30m"/"30M"/"30 m" would split one drill into three series in the
    -- progression graph, which is the one place grouping has to be right.
    -- No archive: a drill is not a person. Clutter is handled by ordering the
    -- picker on last_used_at, so a one-off sinks on its own.
    CREATE TABLE IF NOT EXISTS drills (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'manual',
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      synced INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_drills_used ON drills(last_used_at);

    -- Named lineups built ahead of practice. Loading one COPIES its order into
    -- the live queue (settings), so editing the day's queue never mutates it.
    CREATE TABLE IF NOT EXISTS queue_templates (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      athlete_ids TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      synced INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Column adds for databases created before each column existed.
  const runCols = await tableColumns(db, 'runs');
  if (!runCols.includes('reaction_offset_ms')) {
    await db.execAsync('ALTER TABLE runs ADD COLUMN reaction_offset_ms INTEGER NOT NULL DEFAULT 0');
  }
  if (!runCols.includes('athlete_name')) {
    await db.execAsync('ALTER TABLE runs ADD COLUMN athlete_name TEXT');
  }
  if (!runCols.includes('drill_type')) {
    await db.execAsync('ALTER TABLE runs ADD COLUMN drill_type TEXT');
  }
  // v2: the roster link. NULL = Unassigned, which is a legitimate run state.
  // No REFERENCES clause on purpose: SQLite only enforces FKs with
  // PRAGMA foreign_keys=ON (off by default, per-connection), so a constraint here
  // would be decorative. Athletes are never deleted, so integrity is enforced in
  // code + defensive LEFT JOINs instead of a pragma flip mid-season.
  if (!runCols.includes('athlete_id')) {
    await db.execAsync('ALTER TABLE runs ADD COLUMN athlete_id TEXT');
  }
  await db.execAsync('CREATE INDEX IF NOT EXISTS idx_runs_athlete ON runs(athlete_id)');
  // v3: the drill link. drill_type stays as the frozen snapshot, exactly as
  // athlete_name does — same rollback-safety property.
  if (!runCols.includes('drill_id')) {
    await db.execAsync('ALTER TABLE runs ADD COLUMN drill_id TEXT');
  }
  await db.execAsync('CREATE INDEX IF NOT EXISTS idx_runs_drill ON runs(drill_id)');
  // The coach's own note on a run ("into a headwind", "bad start"). NULL and empty
  // are the same thing — no note — so nothing has to distinguish "never written"
  // from "cleared", and setRunNote() normalizes a blank back to NULL.
  //
  // No SCHEMA_VERSION bump: that gates the one-time DATA backfill, and this is a
  // pure column add with no data to migrate. ensureSchema is idempotent and runs
  // every launch, so an older database picks it up on the next open.
  if (!runCols.includes('note')) {
    await db.execAsync('ALTER TABLE runs ADD COLUMN note TEXT');
  }
  // Which stored video belongs to this run — for BOTH a video-timed run and a
  // gate-timed run with review footage attached.
  //
  // A column rather than a field in raw_json, and the reason is correctness, not
  // tidiness. raw_json answers "how was this timed"; putting the clip there meant
  // attaching footage to a GATE run would have had to write the video engine's
  // JSON over the gate's, flipping runTimeSource to 'video' and moving the run
  // into a different progression series. A review video would have silently
  // reclassified a gate-timed run. The two questions are orthogonal and now live
  // in orthogonal places: raw_json for how it was timed, clip_id for whether
  // there is footage.
  //
  // NULL is the norm. No SCHEMA_VERSION bump — a pure column add with nothing to
  // backfill, picked up by the next launch since ensureSchema is idempotent.
  if (!runCols.includes('clip_id')) {
    await db.execAsync('ALTER TABLE runs ADD COLUMN clip_id TEXT');
  }

  const sessionCols = await tableColumns(db, 'sessions');
  if (!sessionCols.includes('custom_name')) {
    await db.execAsync('ALTER TABLE sessions ADD COLUMN custom_name TEXT');
  }
}

/**
 * One-time data backfill: turn distinct free-text athlete tags into athlete
 * records and relink those runs by id. Case/accent variants of one name fold
 * into a single athlete; the canonical spelling is the MOST RECENT one used.
 *
 * `athlete_name` is deliberately LEFT IN PLACE as a frozen historical snapshot:
 * it makes this migration reversible (an older build still reads it and works)
 * and preserves provenance. Display always prefers the athlete_id join.
 */
async function backfillRoster(db: MigrationDb): Promise<{
  athletesCreated: number;
  runsLinked: number;
  seededFromRecents: number;
  merges: MergedGroup[];
}> {
  const rows = await db.getAllAsync<{ id: string; athlete_name: string; created_at: number }>(
    `SELECT id, athlete_name, created_at FROM runs
      WHERE athlete_id IS NULL AND athlete_name IS NOT NULL AND TRIM(athlete_name) <> ''
      ORDER BY created_at ASC, rowid ASC`,
  );

  const groups = groupByFoldedName(
    rows.map((r) => ({ id: r.id, name: r.athlete_name, at: r.created_at })),
  );

  // Existing athlete records (a partially-applied migration, or records the user
  // already created) — match on the folded name so we never double-create.
  const existing = await db.getAllAsync<{ id: string; display_name: string }>(
    'SELECT id, display_name FROM athletes',
  );
  const byKey = new Map<string, string>();
  for (const a of existing) byKey.set(foldName(a.display_name), a.id);

  let athletesCreated = 0;
  let runsLinked = 0;
  const merges: MergedGroup[] = [];

  for (const [key, g] of groups) {
    const display = canonicalSpelling(g.spellings);
    let id = byKey.get(key);
    if (!id) {
      id = newId();
      // created_at = the athlete's EARLIEST run, so roster order reflects when
      // they actually started appearing rather than when the migration ran.
      await db.runAsync(
        'INSERT INTO athletes (id, display_name, group_name, created_at, archived_at, synced) VALUES (?, ?, NULL, ?, NULL, 0)',
        [id, display, g.firstAt],
      );
      byKey.set(key, id);
      athletesCreated += 1;
    }
    // Chunked: SQLite caps bound variables per statement (999 by default).
    for (const part of chunk(g.rowIds, 200)) {
      const placeholders = part.map(() => '?').join(',');
      await db.runAsync(`UPDATE runs SET athlete_id = ? WHERE id IN (${placeholders})`, [id, ...part]);
      runsLinked += part.length;
    }
    if (g.spellings.size > 1) {
      const variants = [...g.spellings.entries()].map(([s, v]) => `${s} ×${v.count}`);
      merges.push({ display, variants, runs: g.rowIds.length });
    }
  }

  // Names the coach typed but never recorded a run for — preserve that intent so
  // they still appear in the picker after migrating.
  let seededFromRecents = 0;
  const recentsRow = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM settings WHERE key = ?',
    ['recent_athletes'],
  );
  if (recentsRow?.value) {
    let names: unknown = null;
    try {
      names = JSON.parse(recentsRow.value);
    } catch {
      names = null;
    }
    if (Array.isArray(names)) {
      const now = Date.now();
      for (const raw of names) {
        if (typeof raw !== 'string') continue;
        const name = raw.trim();
        if (!name) continue;
        const key = foldName(name);
        if (byKey.has(key)) continue;
        const id = newId();
        await db.runAsync(
          'INSERT INTO athletes (id, display_name, group_name, created_at, archived_at, synced) VALUES (?, ?, NULL, ?, NULL, 0)',
          [id, name, now],
        );
        byKey.set(key, id);
        seededFromRecents += 1;
      }
    }
  }

  return { athletesCreated, runsLinked, seededFromRecents, merges };
}

/**
 * v3: turn distinct free-text drill labels into drill records and relink runs.
 *
 * Reuses the athlete backfill's folding and canonical-spelling rules verbatim
 * (groupByFoldedName + canonicalSpelling), because "30m" vs "30M" splitting one
 * drill into two series is the same defect as two records for one athlete — and
 * it lands directly on the progression graph, whose entire value is grouping.
 *
 * `drill_type` is LEFT IN PLACE as a frozen snapshot, exactly like athlete_name.
 */
async function backfillDrills(db: MigrationDb): Promise<{
  drillsCreated: number;
  drillRunsLinked: number;
  drillMerges: MergedGroup[];
}> {
  const rows = await db.getAllAsync<{ id: string; drill_type: string; created_at: number }>(
    `SELECT id, drill_type, created_at FROM runs
      WHERE drill_id IS NULL AND drill_type IS NOT NULL AND TRIM(drill_type) <> ''
      ORDER BY created_at ASC, rowid ASC`,
  );
  const groups = groupByFoldedName(
    rows.map((r) => ({ id: r.id, name: r.drill_type, at: r.created_at })),
  );

  const existing = await db.getAllAsync<{ id: string; name: string }>('SELECT id, name FROM drills');
  const byKey = new Map<string, string>();
  for (const d of existing) byKey.set(foldName(d.name), d.id);

  const engineKeys = new Set(ENGINE_DRILL_LABELS.map(foldName));
  let drillsCreated = 0;
  let drillRunsLinked = 0;
  const drillMerges: MergedGroup[] = [];

  for (const [key, g] of groups) {
    const name = canonicalSpelling(g.spellings);
    let id = byKey.get(key);
    if (!id) {
      id = newId();
      await db.runAsync(
        'INSERT INTO drills (id, name, kind, created_at, last_used_at, synced) VALUES (?, ?, ?, ?, ?, 0)',
        [id, name, engineKeys.has(key) ? 'engine' : 'manual', g.firstAt, g.lastAt],
      );
      byKey.set(key, id);
      drillsCreated += 1;
    }
    for (const part of chunk(g.rowIds, 200)) {
      const placeholders = part.map(() => '?').join(',');
      await db.runAsync(`UPDATE runs SET drill_id = ? WHERE id IN (${placeholders})`, [id, ...part]);
      drillRunsLinked += part.length;
    }
    if (g.spellings.size > 1) {
      const variants = [...g.spellings.entries()].map(([s, v]) => `${s} ×${v.count}`);
      drillMerges.push({ display: name, variants, runs: g.rowIds.length });
    }
  }

  // Seed the timer's vocabulary. Seeded-but-unused drills are harmless: the
  // picker orders on last_used_at, so anything never used sinks by itself.
  const now = Date.now();
  for (const label of SEED_DRILL_LABELS) {
    const key = foldName(label);
    if (byKey.has(key)) continue;
    const id = newId();
    await db.runAsync(
      'INSERT INTO drills (id, name, kind, created_at, last_used_at, synced) VALUES (?, ?, ?, ?, NULL, 0)',
      [id, label, 'manual', now],
    );
    byKey.set(key, id);
    drillsCreated += 1;
  }

  return { drillsCreated, drillRunsLinked, drillMerges };
}

/**
 * Bring the database to SCHEMA_VERSION. Safe to call on every launch.
 *
 * The version gate is the critical correctness property: initDb() runs at every
 * app start, and without it a re-run would RESURRECT athlete links for runs the
 * coach had deliberately set back to Unassigned.
 */
export async function runMigrations(db: MigrationDb): Promise<MigrationReport> {
  await ensureSchema(db);

  const fromVersion = await getVersion(db);
  const totalRow = await db.getFirstAsync<{ c: number }>('SELECT COUNT(*) AS c FROM runs');
  const legacyRow = await db.getFirstAsync<{ c: number }>(
    `SELECT COUNT(*) AS c FROM runs WHERE athlete_name IS NOT NULL AND TRIM(athlete_name) <> ''`,
  );
  const runsTotal = totalRow?.c ?? 0;
  const runsWithLegacyTag = legacyRow?.c ?? 0;

  const tallies = async () => {
    const unassigned = await db.getFirstAsync<{ c: number }>(
      'SELECT COUNT(*) AS c FROM runs WHERE athlete_id IS NULL',
    );
    const undrilled = await db.getFirstAsync<{ c: number }>(
      'SELECT COUNT(*) AS c FROM runs WHERE drill_id IS NULL',
    );
    return { runsUnassignedAfter: unassigned?.c ?? 0, runsWithoutDrillAfter: undrilled?.c ?? 0 };
  };

  const base: MigrationReport = {
    fromVersion,
    toVersion: fromVersion,
    ranBackfill: false,
    runsTotal,
    runsWithLegacyTag,
    athletesCreated: 0,
    runsLinked: 0,
    seededFromRecents: 0,
    merges: [],
    runsUnassignedAfter: 0,
    drillsCreated: 0,
    drillRunsLinked: 0,
    drillMerges: [],
    runsWithoutDrillAfter: 0,
  };

  if (fromVersion >= SCHEMA_VERSION) return { ...base, ...(await tallies()) };

  // STEPWISE, each step gated on its own version: a database already at v2 runs
  // ONLY the drill backfill. Re-running the athlete step would resurrect links
  // the coach had deliberately cleared — the same hazard the version gate exists
  // to prevent, which is why the steps are separately gated rather than "if not
  // current, run everything".
  //
  // Explicit BEGIN/COMMIT rather than a driver-specific transaction helper, so
  // the identical code path works under expo-sqlite and node:sqlite. A crash
  // mid-backfill rolls back whole — never a half-linked roster.
  await db.execAsync('BEGIN IMMEDIATE');
  let roster = { athletesCreated: 0, runsLinked: 0, seededFromRecents: 0, merges: [] as MergedGroup[] };
  let drills = { drillsCreated: 0, drillRunsLinked: 0, drillMerges: [] as MergedGroup[] };
  try {
    if (fromVersion < 2) roster = await backfillRoster(db);
    if (fromVersion < 3) drills = await backfillDrills(db);
    await setVersion(db, SCHEMA_VERSION);
    await db.execAsync('COMMIT');
  } catch (e) {
    await db.execAsync('ROLLBACK');
    throw e;
  }

  return {
    ...base,
    toVersion: SCHEMA_VERSION,
    ranBackfill: true,
    ...roster,
    ...drills,
    ...(await tallies()),
  };
}
