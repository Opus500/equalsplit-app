# Drills — app-owned parameterized event drills

> **Status: built 2026-07-30 (app-only). Firmware untouched — frozen-candidate `gate-g1-a3`.**
> Two event drills (L Drill, Shuttle Run) run on the v2 raw-event pipeline as ONE parameterized
> engine. The gate emits BEAM_BREAK/BEAM_CLEAR edges; the app owns all meaning — the same
> "write-once dumb gate" contract as Mode 1 (`docs/BLE-CONTRACT.md`, `V2RunEngine`). No new frame,
> no firmware change, so the wrap/ch11 firmware work owes nothing here.

## 1. The common shape

Both drills are the same machine (`src/ble/drills.ts`, `DrillEngine`):

1. **Start = a CLEAR on the start gate.** The athlete is in the start beam; the timer starts the
   instant they leave it. A "loaded" step gates this so a start reflects a real in-beam → out-of-beam
   transition, not a stray clear:
   - `armed` → waiting for the athlete to enter the start beam;
   - a start-gate **break** → `set` (loaded);
   - a start-gate **clear** while `set` → **start** (t0 = the clear's gate micros).
   - `arm()` seeds `set` directly when the start beam is already broken at arm time (the shuttle
     runner staged in the middle gets no fresh break edge — without the seed their leaving is missed).
2. **Then count BREAKs on the count gate**, each qualified by a **lockout**: a break counts only if
   it is at least `lockoutMs` after the previous reference — **t0** for the first counted break, the
   **last counted break** thereafter. Inside the lockout → swallowed. The **Nth** counted break stops
   the timer; `split = round(sdiff32(finishUs, t0) / 1000)` (wrap-safe, same as Mode 1).

The lockout is the whole trick, and it is one parameter with two framings:
- **L Drill** (N=1): the lockout is the **grace window from the start** — the runner passes the count
  gate early (inside the grace → ignored) and again at the end (after the grace → counts, stops).
- **Shuttle** (N=2): the lockout is the **anti-double-count** between passes — one body crossing a
  beam makes several break/clear pairs (a swinging limb), and the lockout collapses them to one pass.
  It must be **longer than a body crossing, shorter than the fastest real turnaround** (~1 s start).

## 2. The two presets

| Drill | key | start gate (CLEAR) | count gate (BREAK) | N | default lockout | tune range / step |
|---|---|---|---|---|---|---|
| L Drill | `l-drill` | 1 (low, hand on the ground) | 2 (tripod at the start line) | 1 | **6.0 s** (grace) | 1–20 s / 0.5 s |
| Shuttle Run | `shuttle` | 1 (in the middle) | 1 (same gate) | 2 | **1.0 s** (between passes) | 0.3–4 s / 0.1 s |

Lockouts are **tuned live** on the Drills screen (steppers, disabled mid-run) and **persisted per
drill** (`drill_lockout_<key>_ms`). The effective config is captured **at arm**, so nudging the value
never changes the run in progress — it applies to the next arm.

## 3. Gates, sync, and validity

- **Shuttle is single-gate** (start gate == count gate): t0 and finish share one clock, so the split
  is **exact with no cross-gate sync** — always saved.
- **L Drill is two-gate** (gate 1 → gate 2): cross-clock, so it needs both gates time-synced, exactly
  like a Mode-1 split. Unsynced → **withheld** (not saved), same rule as Mode 1.
- **Both drills require the session READY** (both gates powered, assigned ids 1/2, synced) to arm.
  The shuttle uses only gate 1, but we deliberately reuse the proven 2-gate bring-up rather than a
  bespoke single-gate arm — far less risk the night before an event. **Keep both gates of the set
  powered even for the shuttle**; gate 2 is ignored by the shuttle config.
- **Which physical gate is "gate 1"** is the bring-up's start/display gate. For the L drill, gate 1
  must be the low hand gate and gate 2 the tripod gate; use the Debug → v2 Lab role swap if the
  physical assignment is reversed. For the shuttle, gate 1 is whichever gate you place in the middle.

## 4. Persistence

Each finished drill saves to the same SQLite history as Mode 1 (`saveRun`), with:
- `mode = DRILL_MODE (3)` — one mode for all app-parameterized drills; the specific drill is the
  `drill_type` label, which is what History groups/averages on (so a new drill = a new label, not a
  new mode). History renders `M3` + the total + the drill tag; averages separate L from shuttle
  because they carry different `drill_type`.
- `total_ms = split`, `split1/2 = 0`, `athlete_name` = the optional tag, `drill_type` = the label
  (editable per rep), `raw_json` = `{engine:'drill', key, counted, countN, lockoutMs, startUs,
  finishUs, synced}`.

## 5. Operating procedure (both drills)

1. Power both gates of the set; wait for the Drills screen session line to read **ready · N/N synced**.
2. Pick the drill; tune the lockout if needed (between reps).
3. Have the athlete get **into** the start beam and hold still. **Arm** (the arm reflects a real
   in-beam state — arm once they're set, not before they walk up, or a walk-up artifact can start it).
4. The athlete **leaves the start beam** → the timer starts. The screen shows the running time and,
   for the shuttle, the pass count.
5. On the Nth pass the timer stops and the run saves (tagged). **Run again** for the next rep.

## 6. Decisions & sharp edges (for the record)

- **Start-on-CLEAR, loaded-gated (not first-clear).** A bare "start on the first clear after arm"
  false-starts on a walk-up leg pass through a low gate 1. Requiring the beam to be broken (or seeded
  broken at arm) before the starting clear ties a start to a real transition. It does NOT solve a
  settling "wiggle" (break/clear while getting set) — that is procedural: arm once the athlete is
  set and still. Documented, accepted.
- **Lockout from t0 for the first counted break (both drills).** Unifies the L "grace from start"
  and the shuttle "ignore the departure wobble." One parameter, one code path.
- **EVENT_REBROADCAST is harmless.** A rebroadcast (same gate micros) is de-duped upstream by
  `kind:gateId:micros`; even if it weren't, a duplicate break has `dt = 0 < lockout` → swallowed.
- **At most one app engine armed at a time.** Arming a drill cancels any Mode-1 arm and the
  standalone watch, and vice-versa — a forgotten arm on the other tab can't later fire a phantom run.
- **Mounted, not on-demand.** The Drills screen stays mounted (hidden) like the Timer, so the
  per-run save guard survives a tab switch — otherwise a completed run re-saves on remount.

## 7. Related: standalone (B1) run logging — opt-in, default OFF

Separate feature in the same session (`StandaloneObserver`, `v2.ts`; setting **Log gate (standalone)
runs**). When on, a Mode-1 run you start on the gate's **B1** button is reconstructed from the event
stream and saved (`mode 1`, `drill_type = 'Standalone'`) — it mirrors the firmware's standalone
pairing exactly (first BEAM_BREAK after the press = start, first break from the other gate = finish),
so the log matches the gate's OLED to the millisecond. It never touches app-armed runs (only arms
when both app engines are idle) and drops a stale arm after ~35 s.

**Why opt-in:** B1 and B2 emit the **same** BUTTON_PRESS (flags 0), so the app can't tell a Mode-1
arm from a Mode-2 press — a Mode-2 (reaction) standalone would be mis-logged as its gate→gate leg.
Off by default so it can never inject a phantom run into an event; turn it on deliberately.
