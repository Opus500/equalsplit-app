// Local-first storage (expo-sqlite). Every finished run is written here so
// results survive app restarts and offline use. A `synced` column is carried
// now so an optional Supabase backup later is a no-migration change.

import * as SQLite from 'expo-sqlite';

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
      synced INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);
  `);
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// A session = one calendar day of runs (YYYY-MM-DD). Created lazily on first run.
async function getOrCreateTodaySession(): Promise<string> {
  const db = await getDb();
  const name = new Date().toISOString().slice(0, 10);
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
       (id, session_id, mode, run_index, started_at, total_ms, split1_ms, split2_ms, status, raw_json, created_at, synced)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
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
    ],
  );
}

export type SessionRow = {
  id: string;
  name: string;
  created_at: number;
  runCount: number;
  bestMs: number | null;
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
  status: string;
  created_at: number;
};

export async function getRuns(sessionId: string): Promise<RunRow[]> {
  const db = await getDb();
  return db.getAllAsync<RunRow>(
    'SELECT id, mode, run_index, total_ms, split1_ms, split2_ms, status, created_at FROM runs WHERE session_id = ? ORDER BY run_index ASC',
    [sessionId],
  );
}
