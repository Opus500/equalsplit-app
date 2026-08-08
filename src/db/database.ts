// Local-first storage (expo-sqlite). Every finished run is written here so
// results survive app restarts and offline use. A `synced` column is carried
// now so an optional Supabase backup later is a no-migration change.
//
// Latency compensation: the gate's split1_ms/split2_ms/total_ms are always the
// RAW authoritative values from the gate clock. For Mode 2 we also store the
// reaction offset that was applied at save time (reaction_offset_ms) so the
// adjusted reaction = split1_ms - reaction_offset_ms can be recomputed and the
// offset re-tuned later without losing anything.

import * as SQLite from 'expo-sqlite';

import {
  drillKindFor,
  foldName,
  runMigrations,
  type BindValue,
  type MigrationDb,
} from './migrations';
import { EMPTY_QUEUE, type QueueState } from '../roster/queue';

export const DEFAULT_REACTION_OFFSET_MS = 150;

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) dbPromise = SQLite.openDatabaseAsync('equalsplit.db');
  return dbPromise;
}

// Adapter onto the dependency-free migration layer (migrations.ts). Written out
// explicitly rather than passing the SQLiteDatabase straight through, because
// expo's methods are overloaded (array form + variadic) and the narrow interface
// is what lets the SAME migration code run under node:sqlite in
// scripts/verify-migration.mjs — i.e. rehearsed on a copy of the real database.
function migrationAdapter(db: SQLite.SQLiteDatabase): MigrationDb {
  return {
    execAsync: (sql: string) => db.execAsync(sql),
    getAllAsync: <T,>(sql: string, params: BindValue[] = []) => db.getAllAsync<T>(sql, params),
    getFirstAsync: <T,>(sql: string, params: BindValue[] = []) => db.getFirstAsync<T>(sql, params),
    runAsync: (sql: string, params: BindValue[] = []) => db.runAsync(sql, params),
  };
}

// Schema + one-time data migrations all live in migrations.ts now (single source
// of truth, and runnable outside the app). Safe to call on every launch.
export async function initDb(): Promise<void> {
  const db = await getDb();
  const report = await runMigrations(migrationAdapter(db));
  if (report.ranBackfill) {
    console.log(
      `[db] migrated v${report.fromVersion}→v${report.toVersion}: ` +
        `${report.athletesCreated} athletes created, ${report.runsLinked} runs linked, ` +
        `${report.seededFromRecents} seeded, ${report.merges.length} name merges, ` +
        `${report.runsUnassignedAfter} unassigned`,
    );
  }
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---- settings (key/value) ----
export async function getSetting(key: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [
    key,
  ]);
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value],
  );
}

export async function getReactionOffsetMs(): Promise<number> {
  const v = await getSetting('reaction_offset_ms');
  const n = v == null ? DEFAULT_REACTION_OFFSET_MS : parseInt(v, 10);
  return Number.isFinite(n) ? n : DEFAULT_REACTION_OFFSET_MS;
}

export async function setReactionOffsetMs(ms: number): Promise<void> {
  await setSetting('reaction_offset_ms', String(Math.max(0, Math.round(ms))));
}

export async function getMeasuredAudioLatencyMs(): Promise<number | null> {
  const v = await getSetting('measured_audio_latency_ms');
  const n = v == null ? NaN : parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

export async function setMeasuredAudioLatencyMs(ms: number): Promise<void> {
  await setSetting('measured_audio_latency_ms', String(Math.round(ms)));
}

// Local calendar day as YYYY-MM-DD, in the device's timezone (NOT UTC). Using
// toISOString() here filed evening runs under the next day because ISO is UTC —
// e.g. 8pm Pacific on the 15th is the 16th in UTC. getFullYear/Month/Date are
// all local, so a run lands under the day it actually happened.
function localDayString(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// A session = one calendar day of runs (YYYY-MM-DD). Created lazily on first run.
async function getOrCreateTodaySession(): Promise<string> {
  const db = await getDb();
  const name = localDayString();
  const existing = await db.getFirstAsync<{ id: string }>(
    'SELECT id FROM sessions WHERE name = ?',
    [name],
  );
  if (existing) return existing.id;
  const id = newId();
  await db.runAsync('INSERT INTO sessions (id, name, created_at, synced) VALUES (?, ?, ?, 0)', [
    id,
    name,
    Date.now(),
  ]);
  return id;
}

export type RunInput = {
  mode: number;
  totalMs: number;
  split1Ms: number;
  split2Ms: number;
  reactionOffsetMs?: number;
  status?: string;
  rawJson?: string;
  /** Roster link. Omit/null = Unassigned, a legitimate state (assign later from
   *  History). This — not the name text — is the attribution of record. */
  athleteId?: string | null;
  /** Denormalized name snapshot. Resolved from athleteId when omitted; you
   *  rarely pass this directly. Kept so an older build (and plain share text)
   *  still reads a name without joining, which is what makes a rollback to a
   *  pre-roster build safe. Display always prefers the athletes join. */
  athleteName?: string | null;
  /** Drill record id, when the caller already has one. Usually omitted — pass
   *  `drillType` and saveRun resolves the record itself. */
  drillId?: string | null;
  /** Drill LABEL. saveRun get-or-creates the matching drill record and links it,
   *  so every write path (both timers, the Drills engine, the standalone
   *  observer, and anything added later) is linked automatically and cannot
   *  silently drop out of the progression graphs by forgetting to. */
  drillType?: string | null;
};

const clean = (s?: string | null) => {
  const t = s?.trim();
  return t ? t : null;
};

/**
 * Insert a finished run. Returns the new `runs.id`.
 *
 * The id matters: the timer's post-run discard control deletes BY ID via
 * deleteRun(). The run is written immediately and durably — never held in memory
 * pending a confirm — because a field phone backgrounds, locks, and takes calls,
 * and losing a real run is far worse than a discardable junk row. Discard is a
 * delete, and it is the same path History uses.
 */
export async function saveRun(r: RunInput): Promise<string> {
  const db = await getDb();
  const sessionId = await getOrCreateTodaySession();
  // MAX+1, not COUNT+1: with COUNT, deleting a run made the next insert REUSE a
  // live index (delete #2 of 3, next run is also #3), so a session could show two
  // "#3"s and run_index was unusable as an identity. MAX+1 is monotonic per
  // session — indices are never reused, and a deleted index just leaves a gap.
  // (runs.id remains the only true identity; this makes the displayed # honest.)
  const row = await db.getFirstAsync<{ next: number }>(
    'SELECT COALESCE(MAX(run_index), 0) + 1 AS next FROM runs WHERE session_id = ?',
    [sessionId],
  );
  const runIndex = row?.next ?? 1;
  const now = Date.now();
  const id = newId();
  const athleteId = clean(r.athleteId);
  // Resolve the name snapshot here so callers can't drift it out of sync with
  // the record. An unassigned run stores NO name — a stale name on an
  // deliberately-unassigned row would render as a legacy "unlinked" tag and be
  // actively misleading.
  let athleteName = clean(r.athleteName);
  if (athleteId && !athleteName) {
    const a = await db.getFirstAsync<{ display_name: string }>(
      'SELECT display_name FROM athletes WHERE id = ?',
      [athleteId],
    );
    athleteName = a?.display_name ?? null;
  }
  if (!athleteId) athleteName = null;

  // Resolve the drill link HERE rather than at each call site. Four write paths
  // exist (v1 timer, v2 timer, Drills engine, standalone observer) and a fifth
  // will appear; resolving centrally means none of them can forget and quietly
  // drop their runs out of the progression graphs.
  let drillId = clean(r.drillId);
  let drillName = clean(r.drillType);
  if (!drillId && drillName) {
    const d = await findOrCreateDrill(drillName);
    drillId = d?.id ?? null;
    drillName = d?.name ?? drillName; // canonical spelling wins over this typing
  } else if (drillId) {
    const d = await db.getFirstAsync<{ name: string }>('SELECT name FROM drills WHERE id = ?', [
      drillId,
    ]);
    drillName = d?.name ?? drillName;
  }

  await db.runAsync(
    `INSERT INTO runs
       (id, session_id, mode, run_index, started_at, total_ms, split1_ms, split2_ms, status, raw_json, created_at, reaction_offset_ms, athlete_id, athlete_name, drill_id, drill_type, synced)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      id,
      sessionId,
      r.mode,
      runIndex,
      now,
      r.totalMs,
      r.split1Ms,
      r.split2Ms,
      r.status ?? 'valid',
      r.rawJson ?? null,
      now,
      r.reactionOffsetMs ?? 0,
      athleteId,
      athleteName,
      drillId,
      drillName,
    ],
  );
  // Recency drives the picker's order — this is what makes a one-off drill sink
  // instead of needing an archive.
  if (drillId) {
    await db.runAsync('UPDATE drills SET last_used_at = ? WHERE id = ?', [now, drillId]);
  }
  return id;
}

/** Re-tag a run's drill by RECORD. Passing null clears the snapshot too, so an
 *  untagged run can't resurface showing stale text — same rule as the athlete. */
export async function updateRunDrill(id: string, drillId: string | null): Promise<void> {
  const db = await getDb();
  const did = clean(drillId);
  let name: string | null = null;
  if (did) {
    const d = await db.getFirstAsync<{ name: string }>('SELECT name FROM drills WHERE id = ?', [did]);
    name = d?.name ?? null;
  }
  await db.runAsync('UPDATE runs SET drill_id = ?, drill_type = ? WHERE id = ?', [did, name, id]);
  if (did) await db.runAsync('UPDATE drills SET last_used_at = ? WHERE id = ?', [Date.now(), did]);
}

/** Single source for run→drill display, mirroring resolvedAthlete: drill_id
 *  alone decides, so a row is never half-linked and the rule never arbitrates. */
export function resolvedDrill(r: RunRow): { name: string | null; legacy: boolean } {
  if (r.drill_id) return { name: r.drill_name ?? r.drill_type?.trim() ?? null, legacy: false };
  const legacyName = r.drill_type?.trim() || null;
  return { name: legacyName, legacy: legacyName != null };
}

// Recently-used athlete names (most-recent first), kept in settings so a freshly
// typed name is available immediately (before any run with it is saved).
const MAX_RECENT_ATHLETES = 12;
export async function getRecentAthletes(): Promise<string[]> {
  const v = await getSetting('recent_athletes');
  if (!v) return [];
  try {
    const arr = JSON.parse(v);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export async function addRecentAthlete(name: string): Promise<string[]> {
  const n = name.trim();
  if (!n) return getRecentAthletes();
  const cur = await getRecentAthletes();
  const next = [n, ...cur.filter((x) => x.toLowerCase() !== n.toLowerCase())].slice(
    0,
    MAX_RECENT_ATHLETES,
  );
  await setSetting('recent_athletes', JSON.stringify(next));
  return next;
}

export type SessionRow = {
  id: string;
  name: string; // the auto date (YYYY-MM-DD); kept as the fallback/subtitle
  created_at: number;
  custom_name: string | null; // user label; display = custom_name || name
  runCount: number;
  // No "best": a session can mix modes and drills (a 10m fly vs a 40yd reaction
  // start aren't comparable), so a single best/avg across the session is
  // misleading. Comparability is decided per-view instead (see HistoryScreen).
};

export async function getSessions(): Promise<SessionRow[]> {
  const db = await getDb();
  return db.getAllAsync<SessionRow>(`
    SELECT s.id, s.name, s.created_at, s.custom_name,
           COUNT(r.id) AS runCount
    FROM sessions s
    LEFT JOIN runs r ON r.session_id = s.id
    GROUP BY s.id
    ORDER BY s.created_at DESC
  `);
}

// Rename a session. Empty/blank reverts to the date (stored as NULL).
export async function setSessionName(id: string, name: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('UPDATE sessions SET custom_name = ? WHERE id = ?', [clean(name), id]);
}

export type RunRow = {
  id: string;
  mode: number;
  /** INTERNAL ordering key — monotonic per session, with GAPS where runs were
   *  deleted/discarded. Never show this to a user: "1, 2, 4" reads as a lost
   *  run. Use display_index. */
  run_index: number;
  /** 1..N position within the session, computed from the ordered set, so a
   *  discarded run closes the gap on screen while storage keeps its history. */
  display_index: number;
  total_ms: number;
  split1_ms: number;
  split2_ms: number;
  reaction_offset_ms: number;
  status: string;
  raw_json: string | null;
  /** Legacy/snapshot text. Do NOT display this directly — use resolvedAthlete(). */
  athlete_name: string | null;
  /** Snapshot text. Do NOT display directly — use resolvedDrill(). */
  drill_type: string | null;
  drill_id: string | null;
  drill_name: string | null;
  created_at: number;
  // --- roster (schema v2), joined ---
  athlete_id: string | null;
  athlete_display_name: string | null;
  athlete_group_name: string | null;
  athlete_archived_at: number | null;
};

export async function getRuns(sessionId: string): Promise<RunRow[]> {
  const db = await getDb();
  // LEFT JOIN, deliberately: a run whose athlete_id somehow doesn't resolve must
  // still appear in history. Losing a time because a link is dangling would be a
  // far worse failure than showing it unattributed.
  return db.getAllAsync<RunRow>(
    `SELECT r.id, r.mode, r.run_index, r.total_ms, r.split1_ms, r.split2_ms,
            r.reaction_offset_ms, r.status, r.raw_json, r.athlete_name, r.drill_type,
            r.created_at, r.athlete_id, r.drill_id,
            ROW_NUMBER() OVER (
              ORDER BY r.run_index ASC, r.created_at ASC, r.rowid ASC
            ) AS display_index,
            a.display_name AS athlete_display_name,
            a.group_name   AS athlete_group_name,
            a.archived_at  AS athlete_archived_at,
            d.name         AS drill_name
       FROM runs r
       LEFT JOIN athletes a ON a.id = r.athlete_id
       LEFT JOIN drills   d ON d.id = r.drill_id
      WHERE r.session_id = ?
      ORDER BY r.run_index DESC`,
    [sessionId],
  );
}

/**
 * The one place run→athlete display is decided, so History, share text, and the
 * timer can't disagree.
 *
 * `athlete_id` ALONE decides which world a row is in — the rule never weighs the
 * link against the text, so a row can't be half-linked:
 *   athlete_id set  → linked. The record's CURRENT name (renames are retroactive).
 *   athlete_id null → the legacy free text, flagged so the UI can grey it.
 *   neither         → Unassigned.
 *
 * Linking a legacy row REPLACES its text (see updateRunAthlete), so the old tag
 * is destroyed at that moment. What remains in athlete_name afterwards is a
 * denormalized snapshot of the record, never a competing value — and it is never
 * read for display while linked, only by a pre-roster build after a rollback.
 */
export function resolvedAthlete(r: RunRow): {
  name: string | null;
  legacy: boolean;
  archived: boolean;
} {
  if (r.athlete_id) {
    return {
      // The snapshot is a fallback ONLY for a dangling id (athletes are never
      // deleted, so this shouldn't occur) — the row is still linked, not legacy.
      name: r.athlete_display_name ?? r.athlete_name?.trim() ?? null,
      legacy: false,
      archived: r.athlete_archived_at != null,
    };
  }
  const legacyName = r.athlete_name?.trim() || null;
  return { name: legacyName, legacy: legacyName != null, archived: false };
}

/** Reassign (or unassign) a run — the History reassignment path. Passing null
 *  clears the name snapshot too, so an intentionally-unassigned run can never
 *  resurface as a legacy "unlinked" tag. */
export async function updateRunAthlete(runId: string, athleteId: string | null): Promise<void> {
  const db = await getDb();
  const id = clean(athleteId);
  let name: string | null = null;
  if (id) {
    const a = await db.getFirstAsync<{ display_name: string }>(
      'SELECT display_name FROM athletes WHERE id = ?',
      [id],
    );
    name = a?.display_name ?? null;
  }
  await db.runAsync('UPDATE runs SET athlete_id = ?, athlete_name = ? WHERE id = ?', [id, name, runId]);
}

// Delete a run; if its session is left empty, remove the session too.
export async function deleteRun(id: string): Promise<void> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ session_id: string }>(
    'SELECT session_id FROM runs WHERE id = ?',
    [id],
  );
  await db.runAsync('DELETE FROM runs WHERE id = ?', [id]);
  if (row) {
    const c = await db.getFirstAsync<{ c: number }>(
      'SELECT COUNT(*) AS c FROM runs WHERE session_id = ?',
      [row.session_id],
    );
    if ((c?.c ?? 0) === 0) {
      await db.runAsync('DELETE FROM sessions WHERE id = ?', [row.session_id]);
    }
  }
}

export type AthleteRunRow = {
  id: string;
  total_ms: number;
  created_at: number;
  status: string;
  drill_id: string | null;
  drill_name: string | null;
};

/**
 * Every run attributed to one athlete, across all sessions — the progression view.
 *
 * Returns SUSPECT and INVALID runs too, rather than filtering in SQL, so the screen
 * can say how many it set aside. Silently dropping them would leave a coach staring
 * at a chart of six points wondering where the seventh went.
 */
export async function getAthleteRuns(athleteId: string): Promise<AthleteRunRow[]> {
  const db = await getDb();
  return db.getAllAsync<AthleteRunRow>(
    `SELECT r.id, r.total_ms, r.created_at, r.status, r.drill_id,
            d.name AS drill_name
       FROM runs r
       LEFT JOIN drills d ON d.id = r.drill_id
      WHERE r.athlete_id = ?
      ORDER BY r.created_at ASC`,
    [athleteId],
  );
}

// ---------------------------------------------------------------------------
// Roster (schema v2). Athletes are ARCHIVED, never deleted, so run history is
// never orphaned — archiving only hides them from pickers.
// ---------------------------------------------------------------------------

export type Athlete = {
  id: string;
  display_name: string;
  group_name: string | null;
  created_at: number;
  archived_at: number | null;
  /** runs currently attributed to this athlete (all sessions) */
  run_count: number;
};

export async function listAthletes(opts?: { includeArchived?: boolean }): Promise<Athlete[]> {
  const db = await getDb();
  const where = opts?.includeArchived ? '' : 'WHERE a.archived_at IS NULL';
  return db.getAllAsync<Athlete>(
    `SELECT a.id, a.display_name, a.group_name, a.created_at, a.archived_at,
            (SELECT COUNT(*) FROM runs r WHERE r.athlete_id = a.id) AS run_count
       FROM athletes a
       ${where}
      ORDER BY a.display_name COLLATE NOCASE ASC`,
  );
}

/** Athletes whose name folds to the same key — powers the "already exists, add a
 *  distinguishing detail?" prompt. Folding matches the migration exactly
 *  (trim → NFC → lowercase), so the prompt fires on the same cases the backfill
 *  would have merged. Includes archived records: a name colliding with an
 *  archived athlete is exactly when the coach needs to be told. */
export async function findAthletesByName(name: string): Promise<Athlete[]> {
  const key = foldName(name);
  const all = await listAthletes({ includeArchived: true });
  return all.filter((a) => foldName(a.display_name) === key);
}

export async function createAthlete(displayName: string, groupName?: string | null): Promise<Athlete> {
  const db = await getDb();
  const name = clean(displayName);
  if (!name) throw new Error('athlete needs a name');
  const id = newId();
  const now = Date.now();
  await db.runAsync(
    'INSERT INTO athletes (id, display_name, group_name, created_at, archived_at, synced) VALUES (?, ?, ?, ?, NULL, 0)',
    [id, name, clean(groupName), now],
  );
  return { id, display_name: name, group_name: clean(groupName), created_at: now, archived_at: null, run_count: 0 };
}

/** Rename / re-group. Renames are retroactive by design: display resolves through
 *  the join, so fixing a typo fixes every past run at once. */
export async function updateAthlete(
  id: string,
  fields: { displayName?: string; groupName?: string | null },
): Promise<void> {
  const db = await getDb();
  if (fields.displayName !== undefined) {
    const name = clean(fields.displayName);
    if (!name) throw new Error('athlete needs a name');
    await db.runAsync('UPDATE athletes SET display_name = ? WHERE id = ?', [name, id]);
  }
  if (fields.groupName !== undefined) {
    await db.runAsync('UPDATE athletes SET group_name = ? WHERE id = ?', [clean(fields.groupName), id]);
  }
}

/** Archive / restore. Never deletes: runs keep pointing at the record, so the
 *  history of someone who left the squad stays intact and attributed. */
export async function setAthleteArchived(id: string, archived: boolean): Promise<void> {
  const db = await getDb();
  await db.runAsync('UPDATE athletes SET archived_at = ? WHERE id = ?', [
    archived ? Date.now() : null,
    id,
  ]);
}

// ---------------------------------------------------------------------------
// Drills (schema v3). Records, not free text — "30m"/"30M" would otherwise split
// one drill into two series in the progression graph.
//
// No archive: a drill is not a person. Clutter is handled by ORDERING on
// last_used_at, so a one-off ("sled push") sinks on its own without any state
// for the coach to manage.
// ---------------------------------------------------------------------------

export type Drill = {
  id: string;
  name: string;
  /** 'manual' = the timer's vocabulary; 'engine' = owned by the Drills screen */
  kind: string;
  created_at: number;
  last_used_at: number | null;
  run_count: number;
};

/** Most-recently-used first; never-used last, alphabetical. `kind` defaults to
 *  'manual' because the timer must not offer L Drill / Shuttle Run. */
export async function listDrills(opts?: { kind?: 'manual' | 'engine' | 'all' }): Promise<Drill[]> {
  const db = await getDb();
  const kind = opts?.kind ?? 'manual';
  const where = kind === 'all' ? '' : 'WHERE d.kind = ?';
  const params: BindValue[] = kind === 'all' ? [] : [kind];
  return db.getAllAsync<Drill>(
    `SELECT d.id, d.name, d.kind, d.created_at, d.last_used_at,
            (SELECT COUNT(*) FROM runs r WHERE r.drill_id = d.id) AS run_count
       FROM drills d
       ${where}
      ORDER BY d.last_used_at IS NULL ASC, d.last_used_at DESC, d.name COLLATE NOCASE ASC`,
    params,
  );
}

/** Resolve a label to its record, creating it if new. Folded lookup, so a
 *  differently-cased retype joins the existing drill instead of forking it. */
export async function findOrCreateDrill(name: string): Promise<Drill | null> {
  const db = await getDb();
  const clean0 = clean(name);
  if (!clean0) return null;
  const key = foldName(clean0);
  const all = await db.getAllAsync<{ id: string; name: string }>('SELECT id, name FROM drills');
  const hit = all.find((d) => foldName(d.name) === key);
  if (hit) {
    const row = await db.getFirstAsync<Drill>(
      `SELECT id, name, kind, created_at, last_used_at,
              (SELECT COUNT(*) FROM runs r WHERE r.drill_id = drills.id) AS run_count
         FROM drills WHERE id = ?`,
      [hit.id],
    );
    return row ?? null;
  }
  const id = newId();
  const now = Date.now();
  const kind = drillKindFor(clean0);
  await db.runAsync(
    'INSERT INTO drills (id, name, kind, created_at, last_used_at, synced) VALUES (?, ?, ?, ?, NULL, 0)',
    [id, clean0, kind, now],
  );
  return { id, name: clean0, kind, created_at: now, last_used_at: null, run_count: 0 };
}

/** Renames are retroactive (display resolves through the join), so fixing a
 *  typo fixes every past run and keeps their runs in one graph series. */
export async function renameDrill(id: string, name: string): Promise<void> {
  const db = await getDb();
  const n = clean(name);
  if (!n) throw new Error('drill needs a name');
  await db.runAsync('UPDATE drills SET name = ? WHERE id = ?', [n, id]);
}

/** Cleanup escape hatch — allowed ONLY when nothing references it, so this can
 *  never orphan a run. A drill with runs is kept forever (it just sinks). */
export async function deleteDrillIfUnused(id: string): Promise<boolean> {
  const db = await getDb();
  const c = await db.getFirstAsync<{ c: number }>(
    'SELECT COUNT(*) AS c FROM runs WHERE drill_id = ?',
    [id],
  );
  if ((c?.c ?? 0) > 0) return false;
  await db.runAsync('DELETE FROM drills WHERE id = ?', [id]);
  return true;
}

// ---------------------------------------------------------------------------
// Queue templates — named lineups built ahead of practice.
// ---------------------------------------------------------------------------

export type QueueTemplate = { id: string; name: string; athleteIds: string[]; created_at: number };

function parseIds(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export async function listTemplates(): Promise<QueueTemplate[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ id: string; name: string; athlete_ids: string; created_at: number }>(
    'SELECT id, name, athlete_ids, created_at FROM queue_templates ORDER BY name COLLATE NOCASE ASC',
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    athleteIds: parseIds(r.athlete_ids),
    created_at: r.created_at,
  }));
}

export async function createTemplate(name: string, athleteIds: string[]): Promise<QueueTemplate> {
  const db = await getDb();
  const n = clean(name) ?? 'Lineup';
  const id = newId();
  const now = Date.now();
  await db.runAsync(
    'INSERT INTO queue_templates (id, name, athlete_ids, created_at, synced) VALUES (?, ?, ?, ?, 0)',
    [id, n, JSON.stringify(athleteIds), now],
  );
  return { id, name: n, athleteIds, created_at: now };
}

export async function updateTemplate(
  id: string,
  fields: { name?: string; athleteIds?: string[] },
): Promise<void> {
  const db = await getDb();
  if (fields.name !== undefined) {
    await db.runAsync('UPDATE queue_templates SET name = ? WHERE id = ?', [
      clean(fields.name) ?? 'Lineup',
      id,
    ]);
  }
  if (fields.athleteIds !== undefined) {
    await db.runAsync('UPDATE queue_templates SET athlete_ids = ? WHERE id = ?', [
      JSON.stringify(fields.athleteIds),
      id,
    ]);
  }
}

/** Templates are ordinary documents, not people — deleting one is safe and does
 *  not touch athletes or runs. (Contrast: athletes are only ever archived.) */
export async function deleteTemplate(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM queue_templates WHERE id = ?', [id]);
}

// ---------------------------------------------------------------------------
// Live practice queue (settings-backed, survives restarts).
// ---------------------------------------------------------------------------

// Shape + semantics live in ../roster/queue (pure, verifiable); this module only
// persists them. Re-exported so callers have one import for queue state.
export { EMPTY_QUEUE, type QueueState };

export async function getQueueState(): Promise<QueueState> {
  const raw = await getSetting('practice_queue');
  if (!raw) return EMPTY_QUEUE;
  try {
    const v = JSON.parse(raw);
    return {
      athleteIds: Array.isArray(v?.athleteIds)
        ? v.athleteIds.filter((x: unknown): x is string => typeof x === 'string')
        : [],
      cursorId: typeof v?.cursorId === 'string' ? v.cursorId : null,
      overrideId: typeof v?.overrideId === 'string' ? v.overrideId : null,
    };
  } catch {
    return EMPTY_QUEUE;
  }
}

export async function setQueueState(q: QueueState): Promise<void> {
  await setSetting('practice_queue', JSON.stringify(q));
}
