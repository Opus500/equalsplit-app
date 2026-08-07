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
- Canonical `display_name` = the **most frequently used** spelling; ties break to the most
  recent. Explicitly *not* "most recent": a caps-lock session is a keyboard state, not a naming
  decision, and would permanently rename the athlete. Explicitly *not* an uppercase-detection
  heuristic either — plenty of names legitimately carry caps (McRae, DeAndre, O'Neill), and a
  rule that "fixes" them is worse than the problem. Frequency is the honest signal.
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
| Case/accent variants | Merge into one athlete; canonical = **most frequent** spelling, ties → most recent |
| `athlete_name` | Keep as frozen snapshot (rollback safety + provenance); never displayed when linked |
| Duplicate names | Allowed; prompt for a `group_name` detail; date+id suffix only as last resort |
| Standalone (B1) runs | Save **Unassigned**, never auto-attributed; do not advance the queue |
| Queue wrap | Wraps, and the strip shows an explicit "restarting lineup" state |
| Queue jump off-queue | Transient override; cursor doesn't move; resumes after that run |
| Cursor under reorder | Stored as an **athlete id, not an index** — structurally cannot double-run or skip |
| Discard | Run is **saved immediately**, discard is a `deleteRun(id)` — same path as History delete |
| Reorder interaction | Pure JS tap-to-pick / tap-to-place. **No** gesture-handler or reanimated |
| Athlete merge tool | Out of scope |

### run_index is internal; the UI shows a display position

`run_index` is `MAX+1`, so it is monotonic per session and **has gaps** wherever a run was
discarded or deleted — correct storage behavior, and worth keeping. But a coach reading
"1, 2, 4" sees a lost run, so it must never surface. `getRuns` computes

```sql
ROW_NUMBER() OVER (ORDER BY r.run_index ASC, r.created_at ASC, r.rowid ASC) AS display_index
```

and every user-facing number uses `display_index`. It is computed over the whole session
(the window runs after `WHERE`), so History's client-side athlete filter can't renumber it.

The `created_at, rowid` tiebreak also repairs a legacy symptom: databases written before the
`MAX+1` fix contain **duplicate** `run_index` values from the old `COUNT(*)+1`, and those now
display as a clean contiguous 1..N instead of showing two "#3"s.

| | |
|---|---|
| stored (after discards) | `1, 2, 4, 5, 6, 8, 9` |
| displayed | `#1 … #7` |
| legacy duplicates `1,2,3,3,4,4` | `#1 … #6` |

### Why discard is a delete, not a deferred insert

An earlier draft held the finished run in memory for the discard window and only inserted it if
the coach didn't discard. That is wrong for a field phone: backgrounding, screen lock, and
incoming calls all kill the holding state, so it would trade a rare junk row for **occasional
loss of a real run**. Durability first — the run is written the instant it completes, and
discard deletes it by id. It follows that the discard control keeps working after the window
closes: once saved it is an ordinary row, and History's delete is the identical path.

## 6. Storage API (landed — no UI yet)

| Function | Purpose |
|---|---|
| `saveRun(...)` → `Promise<string>` | now takes `athleteId`, resolves the name snapshot itself, and **returns the run id** (what discard deletes by) |
| `getRuns(sessionId)` | `LEFT JOIN athletes`; adds `athlete_id`, `athlete_display_name`, `athlete_group_name`, `athlete_archived_at` |
| `resolvedAthlete(row)` | the single place run→name display is decided (linked → record name; unlinked+tagged → legacy, flagged; else Unassigned) |
| `updateRunAthlete(runId, athleteId\|null)` | reassignment; `null` also clears the snapshot |
| `listAthletes` / `findAthletesByName` / `createAthlete` / `updateAthlete` / `setAthleteArchived` | roster CRUD (archive, never delete) |
| `listTemplates` / `createTemplate` / `updateTemplate` / `deleteTemplate` | named lineups |
| `getQueueState` / `setQueueState` | live queue in settings; cursor is an athlete id |

`LEFT JOIN` is deliberate: a run whose `athlete_id` somehow doesn't resolve must still appear —
losing a time to a dangling link would be far worse than showing it unattributed. Renames are
retroactive by design (display resolves through the join), so fixing a typo fixes every past run.

## 7. Not yet done (next commit)

**UI**: roster screen, athlete picker (with duplicate-name prompt), `UpNextStrip` on all three
timing screens, History reassignment + Unassigned filter chip, template editor, tap-to-place
reorder, and the discard control.

⚠️ **This commit is not shippable alone.** Until the storage API writes `athlete_id` on new
runs, runs saved by the current UI would land unlinked and the version-gated backfill will not
pick them up. Land the roster work as a set, and keep the event phones on `master`.
