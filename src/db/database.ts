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

export const DEFAULT_REACTION_OFFSET_MS = 150;

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) dbPromise = SQLite.openDatabaseAsync('equalsplit.db');
  return dbPromise;
}

export async function initDb(): Promise<void> {
  const db = await getDb();
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
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
      synced INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
  `);

  // Migration for DBs created before reaction_offset_ms existed.
  const cols = await db.getAllAsync<{ name: string }>('PRAGMA table_info(runs)');
  if (!cols.some((c) => c.name === 'reaction_offset_ms')) {
    await db.execAsync('ALTER TABLE runs ADD COLUMN reaction_offset_ms INTEGER NOT NULL DEFAULT 0');
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
};

export async function saveRun(r: RunInput): Promise<void> {
  const db = await getDb();
  const sessionId = await getOrCreateTodaySession();
  const row = await db.getFirstAsync<{ c: number }>(
    'SELECT COUNT(*) AS c FROM runs WHERE session_id = ?',
    [sessionId],
  );
  const runIndex = (row?.c ?? 0) + 1;
  const now = Date.now();
  await db.runAsync(
    `INSERT INTO runs
       (id, session_id, mode, run_index, started_at, total_ms, split1_ms, split2_ms, status, raw_json, created_at, reaction_offset_ms, synced)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      newId(),
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
    ],
  );
}

export type SessionRow = {
  id: string;
  name: string;
  created_at: number;
  runCount: number;
  bestMs: number | null; // best raw total of valid runs (the reaction correction is
  // unreliable, so it is never subtracted from totals — see docs/LATENCY.md)
};

export async function getSessions(): Promise<SessionRow[]> {
  const db = await getDb();
  return db.getAllAsync<SessionRow>(`
    SELECT s.id, s.name, s.created_at,
           COUNT(r.id) AS runCount,
           MIN(CASE WHEN r.status = 'valid' THEN r.total_ms END) AS bestMs
    FROM sessions s
    LEFT JOIN runs r ON r.session_id = s.id
    GROUP BY s.id
    ORDER BY s.created_at DESC
  `);
}

export type RunRow = {
  id: string;
  mode: number;
  run_index: number;
  total_ms: number;
  split1_ms: number;
  split2_ms: number;
  reaction_offset_ms: number;
  status: string;
  raw_json: string | null;
  created_at: number;
};

export async function getRuns(sessionId: string): Promise<RunRow[]> {
  const db = await getDb();
  return db.getAllAsync<RunRow>(
    'SELECT id, mode, run_index, total_ms, split1_ms, split2_ms, reaction_offset_ms, status, raw_json, created_at FROM runs WHERE session_id = ? ORDER BY run_index DESC',
    [sessionId],
  );
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
