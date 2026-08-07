# Athlete roster — migration & verification

> **Status: schema + backfill landed on `feature/roster`. UI not built yet.**
> Runs reference an athlete **record** (`runs.athlete_id`) instead of free-text.
> Storage + UI only — no firmware, no BLE, no change to the run timing path.

## 1. Schema (v2)

```sql
CREATE TABLE athletes (
  id TEXT PRIMARY KEY NOT NULL,
  display_name TEXT NOT NULL,
  group_name   TEXT,            -- free text; also the coach-authored disambiguator
  created_at   INTEGER NOT NULL,
  archived_at  INTEGER,         -- NULL = active. Archived, never deleted.
  synced       INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE queue_templates (   -- named lineups; loading one COPIES into the live queue
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  athlete_ids TEXT NOT NULL,     -- JSON array, ordered
  created_at INTEGER NOT NULL,
  synced INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE runs ADD COLUMN athlete_id TEXT;   -- NULL = Unassigned (valid state)
CREATE INDEX idx_runs_athlete ON runs(athlete_id);
```

`runs.athlete_name` is **kept**, frozen as a historical snapshot. It makes the migration
reversible (an older build still reads it and works — this is what protects the event build)
and preserves provenance. Display always prefers the `athlete_id` join; legacy text is only a
fallback for an unlinked row.

No `REFERENCES` clause: SQLite enforces FKs only under `PRAGMA foreign_keys=ON` (off by default,
per-connection), so the constraint would be decorative. Athletes are never deleted, so integrity
is held in code plus defensive `LEFT JOIN`s.

## 2. Backfill rules

- Distinct tags → athlete records, folded **case- and accent-insensitively** in JS
  (`trim → NFC → toLocaleLowerCase`). Not in SQL: SQLite's `lower()` is ASCII-only, so
  `JOSÉ`/`josé` would not fold and you'd get two records for one person.
- Canonical `display_name` = the spelling from the **most recent** run.
- `athletes.created_at` = that athlete's **earliest** run, so roster order reflects when they
  first appeared, not when the migration ran.
- Names in `settings['recent_athletes']` with no runs yet are **seeded** (preserves intent).
- Empty/NULL tags stay **Unassigned** — a legitimate state, assignable later from History.
- Gated on `settings['schema_version'] < 2`, then stamped. **This gate is the critical
  correctness property**: `initDb()` runs at every launch, and without it a re-run would
  resurrect athlete links for runs deliberately set back to Unassigned.
- Whole backfill runs in `BEGIN IMMEDIATE … COMMIT`, rolled back on any error.

## 3. Pull the database off the device

The app opens `equalsplit.db` via expo-sqlite, so on iOS it lives in the app container at
`Documents/SQLite/equalsplit.db`.

> ⚠️ **The DB is in WAL mode** (`PRAGMA journal_mode = WAL`). The newest runs may still be in
> `equalsplit.db-wal`, not the `.db`. **Copy all three files** (`.db`, `.db-wal`, `.db-shm`) or
> you will verify against stale data.

**Option A — Xcode GUI (most reliable):**
1. Connect the iPhone, open Xcode → **Window ▸ Devices and Simulators** (⇧⌘2).
2. Select the device → **Installed Apps** → **EqualSplit** → the **⋯/gear** menu →
   **Download Container…** → save the `.xcappdata`.
3. Right-click it → **Show Package Contents** → `AppData/Documents/SQLite/` → copy
   `equalsplit.db`, `equalsplit.db-wal`, `equalsplit.db-shm` out.

**Option B — command line (Xcode 15+):**
```bash
xcrun devicectl list devices                       # find the device identifier
xcrun devicectl device copy from --device <DEVICE_ID> \
  --domain-type appDataContainer \
  --domain-identifier com.equalsplit.app \
  --source Documents/SQLite/equalsplit.db \
  --destination ./equalsplit.db
# repeat for equalsplit.db-wal and equalsplit.db-shm
```
*(Option B's flags are from the Xcode 15 `devicectl` interface and were not verifiable from the
Windows dev box — if it argues, use Option A, which is the dependable path.)*

## 4. Verify the backfill on that copy

```bash
node scripts/verify-migration.mjs ./equalsplit.db      # a real copy
node scripts/verify-migration.mjs --demo               # synthetic messy DB, no device needed
```

Requires **Node ≥ 22.6** (Node 24 needs no flag) and **no npm packages** — `node:sqlite` is
built in. The script imports `src/db/migrations.ts` directly and runs **the same code the app
runs**, not a reimplementation, which is the entire point of rehearsing it. It also copies your
file again internally (`*.verify.db`), so the pulled file stays pristine.

It prints BEFORE/AFTER row counts, the migration report, every name merge, the resulting roster
with per-athlete run counts, and an **idempotency check** (a second pass must be inert, exactly
as on the next app launch). It exits non-zero if run counts changed, links don't match the
tagged-run count, the version wasn't stamped, or the second pass wasn't inert.

**What to look at on real data:** the `NAME MERGES` block. The canonical name is the *most
recent* spelling, so if a session was typed in caps the record can come out as `JAYDEN`. If the
picks look wrong on your data, the rule is a one-line change (most-frequent spelling, or
most-recent-non-uppercase) — check before the UI is built on top.

The `MODULE_TYPELESS_PACKAGE_JSON` warning from Node is cosmetic (TS reparsed as ESM).

## 5. Decisions of record

| Decision | Call |
|---|---|
| Case/accent variants | Merge into one athlete; canonical = most recent spelling |
| `athlete_name` | Keep as frozen snapshot (rollback safety + provenance) |
| Duplicate names | Allowed; prompt for a `group_name` detail; date+id suffix only as last resort |
| Standalone (B1) runs | Save **Unassigned**, never auto-attributed; do not advance the queue |
| Queue wrap | Wraps, and the strip shows an explicit "restarting lineup" state |
| Queue jump off-queue | Transient override; cursor doesn't move; resumes after that run |
| Cursor under reorder | Tracks the **athlete**, not the index — never double-run, never skip |
| Discard window | Run is held and **not inserted** until the window elapses or the next rep arms |
| Athlete merge tool | Out of scope |

## 6. Not yet done (next commits)

1. **Storage API**: `athleteId` on `saveRun`, roster CRUD (create/rename/archive), `getRuns`
   joined to `athletes`, `updateRunAthlete`, template CRUD, queue persistence.
2. **UI**: roster screen, athlete picker, `UpNextStrip` on all three timing screens, History
   reassignment + Unassigned filter chip, template editor, drag-to-reorder.

⚠️ **This commit is not shippable alone.** Until the storage API writes `athlete_id` on new
runs, runs saved by the current UI would land unlinked and the version-gated backfill will not
pick them up. Land the roster work as a set, and keep the event phones on `master`.
