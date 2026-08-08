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

## 4b. Drills are records too (schema v3)

Same reasoning as athletes, and the progression graph is what forces it: grouping by free
text splits `30m` / `30M` / `30 m ` into separate series, which is precisely the feature whose
value *is* the grouping. `drills` (id, name, kind, created_at, last_used_at); `runs.drill_id`
alongside the frozen `drill_type` snapshot. The v3 backfill reuses the athlete folding and
`canonicalSpelling` verbatim.

**No archive — drills are not people.** Clutter is handled by ordering the picker on
`last_used_at`, so a drill tried once ("sled push") sinks below what's in rotation and falls
behind "More…" on its own. `deleteDrillIfUnused` is the only removal and refuses when any run
references it, so it can never orphan a run.

**`kind` scopes the vocabulary.** `engine` drills (`L Drill`, `Shuttle Run`, `Standalone`) are
written by the Drills screen and standalone observer; the timers' picker shows `manual` only, so
a Mode-1 run is never offered "L Drill". History uses `all` because re-tagging may target either.
This is what the "trim the timer list" request means now: seeded with 10m/20m/30m/40yd, plus
whatever labels real runs actually carry.

**Linking is central, not per-call-site.** `saveRun` resolves `drill_id` from the label itself
(get-or-create, folded). All four write paths — v1 timer, v2 timer, Drills engine, standalone
observer — link automatically, and a fifth added later cannot forget and silently drop its runs
out of the graphs.

The Drills screen no longer offers a free-text label override: the drill *is* the engine's, and
an override would mint `manual` records for engine runs and split them out of their own series.

## 4c. Progression graphs

`src/roster/progression.ts` is pure and dependency-free (verified by
`scripts/verify-progression.mjs`); `ProgressionChart.tsx` only turns its fractions into
pixels. **Hand-rolled from Views** — a line chart is horizontal rules, circles, and rotated
rectangles, none of which justify a native module on a build that prebuilds clean.

**One chart per drill, never one chart across drills.** Grouping is by `drill_id`, so a
rename keeps a series intact and a case variant can't split one. On real data a shared axis
would span ~1000ms while the actual signal inside each drill is ~100ms — the trend would be
the athlete alternating distances, not their progress.

| Rule | Call |
|---|---|
| Threshold | `MIN_SERIES_RUNS = 3`. Two points draw a line but not a trend |
| Below threshold | Listed as "+N to chart" with best time — actionable, not hidden |
| y-axis | **Never zero-based** (a 100ms gain would occupy 2.4% of the plot); floored at `MIN_Y_SPAN_MS = 200` so a 10ms wobble isn't dramatised |
| y direction | Time increases **upward**, so improvement FALLS. Flipping it would put 4.0s above 4.4s on an axis labelled in seconds |
| x-axis | Run **order**, not wall-clock — a layoff would otherwise squash a season into the left edge. Dates are on the axis labels |
| Unlabeled runs | Counted, never charted. An "untagged" bucket would mix a 10m and a 40yd — the exact prohibition |
| `suspect` / `invalid` runs | Excluded and counted. A false trigger lands as an impossibly fast time, i.e. a PB that never happened |
| Touch targets | Full-height **columns**, not dots: a 10px dot is untappable, and a dozen runs sit closer together than a fingertip |
| Ticks | Chosen by resulting tick *count*, not by rounding the interval up — the naive rule drew 2 gridlines on a 226ms span |

Reached by tapping a roster row, which now opens **detail** rather than the edit form (edit
is a button inside it). The form is **nested inside** the detail modal: on iOS, dismissing
one root-level `Modal` while presenting another in the same frame can drop the second.

`scripts/verify-migration.mjs` prints a **SERIES DENSITY** block importing the same
`MIN_SERIES_RUNS`, so "will this screen be empty on my data?" is measured, not guessed. A run
reaches a chart only with **both** an athlete and a drill, so that intersection is the number
that matters — not either count alone.

## 4d. The discard window

Rules in `src/runs/pending.ts` (pure, verified by `scripts/verify-pending.mjs`); the two
guards that can't live in a screen are in `PendingRunProvider`.

**No timer.** The window stays open until the next rep is armed. A fixed duration means
glancing away costs you the chance to bin a bad rep. What closes it instead is anything
meaning "you are no longer looking at this run":

| Close path | Trigger |
|---|---|
| `next-rep` | the screen's arm control — `doArm` on both timers and Drills |
| `dismissed` | the **Keep** button. Clearing the bar by hand IS "keep this run" |
| `superseded` | a newer run took the window |
| `disconnected` | no gate link remains (`v2.connected \|\| gate.status`) — and only if one was up when the window opened |
| `backgrounded` | `AppState` → `background`. **Not** `inactive`: iOS fires that for the app switcher, Control Centre and call banners |

Every close path **keeps** the run. Only `discard` deletes, and it deletes by id — the run
was written durably the instant it finished (§ "Why discard is a delete"), so no close path
can lose data.

**A second run supersedes: the window moves to the newest.** The hazard that creates is
that the run on screen is no longer the run the button deletes — a false trigger followed by
the real rep is exactly that sequence. So the control **names its target** ("4.20s · Marcus ·
30m"); an unlabelled *Discard* would bin the wrong rep.

**Standalone (B1) runs never take the window and never close one.** Nobody was driving the
phone, so the window — an affordance for "the rep I just watched" — would be pointing at a
run the coach never saw. Consistent with B1 runs already saving Unassigned and not advancing
the queue. This is structural, not just a rule: the standalone path writes from `V2Provider`,
which sits *above* `PendingRunProvider` and cannot reach it.

**Discarding reverts the queue.** `completeRun()` advanced the cursor; `revertAdvance()`
puts that athlete back up, because the rep didn't count. It restores a whole `QueueState`
snapshot (same mechanism as skip-undo) and no-ops if the coach changed the queue since.

Suspect and invalid runs DO get a window — an early break is the single most likely thing a
coach wants to bin, so withholding the control there would remove it exactly when needed.

## 4e. Queue templates

Loading **replaces** the live lineup ("today's lineup is this group"), never appends —
appending would silently grow the lineup every time the same template was re-loaded.

Because it replaces, it can destroy work: if the current lineup already has runs against it
**today**, loading confirms first and states the count. That count comes from
`countTodayRunsForAthletes()` — derived from the runs table, not tracked in state, because a
counter would reset on an app restart mid-practice, which is precisely when a coach reaches
for a template and can least afford a silent wipe. An empty or untouched lineup loads with no
prompt: a confirm nobody needs is a confirm everybody learns to dismiss.

Templates are documents, not people — they are **deleted**, not archived, and deleting one
touches no athletes and no runs.

## 4f. Test-data prune (dev-mode maintenance)

Predicate in `src/runs/prune.ts` (pure, verified by `scripts/verify-prune.mjs`), shared by
the preview and the delete so they cannot diverge:

```
athlete_id IS NULL  AND  created_at < cutoff
```

**Drill is deliberately not in it.** A run with a drill but no athlete is still
unattributed, and on real data that is most of the test rows. What is spared is anything
*attributed*, however old, plus any unassigned run newer than the cutoff.

**The date bound is the safety property, not a convenience.** `athlete_id IS NULL` alone
would be unsafe as a standing control: Unassigned is a legitimate ongoing state — standalone
B1 runs save that way by design — so an unbounded version would quietly eat real data months
later. The cutoff keeps this a one-time cleanup rather than a permanent hazard in the app.

Flow: **distribution → cutoff → preview → confirm twice.** The histogram buckets runs by
week or month showing `unassigned/total` per period, so an all-unassigned test week is
obvious and a cutoff can be picked from the data instead of guessed. Only then does it show
the count, a five-row sample of what goes, and the two-step confirm. Deleting is unreachable
without having seen the count.

Runs only. Athletes and drills are never touched — a drill left with zero runs survives and
sinks in the picker on its own. Sessions left empty are removed, the same tidy-up
`deleteRun()` already does for one row. The whole thing runs in `BEGIN IMMEDIATE … COMMIT`.

Reached from **Diagnostics ▸ Prune data**, which is behind dev mode (default OFF).

## 4g. Drill management (rename / delete), in the picker

Behind **Manage** in the drill picker, so picking a drill stays one tap.

**Rename MERGES on a folded-name collision, rather than blocking.** Blocking makes the
case this exists for worse: you type `gs`, run a rep, realise it should have been
`10m start` — a name that already exists — and a block leaves the typo permanent. Merge
moves the runs and keeps them in one series, which is the entire reason drills are
records. It is not silent: the confirm states both run counts and that the old record
goes. A pure case fix (`10M START` → `10m start`) matches the *same* record by folded
name, so it is a rename, not a self-merge.

Rename rewrites the `drill_type` snapshot too. That column exists only so a pre-v3 build
reads a label after a rollback; a stale one would show the old name.

**Delete keeps the runs, always.** Zero-run drills go outright. A drill with runs deletes
after a confirm naming the count; its runs stay in History, lose the label, and drop out
of the graphs. Both `drill_id` and `drill_type` are cleared, so a run can't resurface
carrying a label for a record that no longer exists — the same rule `updateRunDrill(null)`
follows.

**Engine drills are locked.** `L Drill` / `Shuttle Run` / `Standalone` are written by the
engine *by label*, so renaming one would orphan the series — the next rep would mint a
fresh record under the old name. They only appear here under `kind='all'` (History) and
are shown as "set by drill mode".

**No interaction with the prune.** The prune predicate keys on `athlete_id` alone, so
clearing `drill_id` cannot make a run newly prunable. The only visible effect is that the
prune preview's "…of which carry a drill" line goes down.

## 4h. Tap-to-place reorder

`ReorderList` — pure JS, **no gesture-handler, no reanimated**. Tap a row to pick it up,
the gaps become drop slots, tap one to place. Chosen over drag: a long-press-drag one-handed
at the side of a track is fiddly, it would have cost two native dependencies, and two taps
are interruptible — you can look up mid-reorder and come back.

Slot → index is `slotToIndex()` in `roster/queue.ts`. With n athletes there are **n+1
slots**, and `reorder()` splices the item out before reinserting, so every slot after
`from` shifts down one; without the correction a downward move lands one place short.
`verify-queue.mjs` block 7f checks **all 20 (from, slot) pairs** on a four-athlete lineup,
that nobody is lost or duplicated, and that both slots adjacent to the picked row are no-ops.

`LineupEditorModal` is the same component for both callers, differing only in persistence:

| | live lineup | template |
|---|---|---|
| reached from | Roster ▸ **Order** | Templates ▸ **Order** |
| each move | persists immediately via `RosterProvider.moveInQueue` | edits a local array |
| written | every move | on Done, only if changed |
| cursor | shown as **UP**, tracks the athlete | n/a |

Block 7g restates the cursor guarantee through the tap-to-place path: move the athlete who
is UP to the end of the lineup and they are **still up**, because the cursor is an athlete
id, not an index. `moveInQueue` calls `clearUndos()`, so a reorder invalidates a pending
skip undo — the snapshot holds the old order and restoring it would silently undo the move.

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

## 7. Not yet done

Built: roster screen, athlete picker (with duplicate-name prompt), `UpNextStrip` on all three
timing screens (with Skip + undo), History reassignment + Unassigned filter chip, drill records
(with rename/merge and delete), the progression graphs, queue templates, tap-to-place reorder,
the discard window, and the dev-gated test-data prune.

**The roster set is complete.** Everything above is verified as logic
(`scripts/verify-{queue,labels,migration,progression,pending,prune}.mjs`, all exit 0) but only
partly on hardware — the discard window's background/disconnect guards and all touch targets
still need a device pass.

⚠️ **Do not build the event phones from this branch.** They stay on `master` (`f232a4d`) until
the set above lands together — a partial roster build saves runs the backfill has already been
gated past.
