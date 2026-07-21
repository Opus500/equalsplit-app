# EqualSplit BLE / Wire Contract v2 — write-once gate

The frozen wire contract between the **phone app** and the **gates**. v2 makes the gate
*dumb and permanent*: it timestamps physical events and broadcasts raw packets. It has no
concept of drills, splits, modes, or "when a run ends." All meaning lives in the app.

> **Protocol version: 2.** Reported in `STATUS_REPLY` / legacy `Status`. v1 (the high-level
> `STATE/GO/SPLIT/FINISH` contract) remains live during the phased migration (§13); its full
> text is in git history.

### The one rule

> **The gate may know about TIME. It must not know about MEANING.**
> Time-sync plumbing is allowed (so cross-gate timestamps are comparable). Computing a
> split, deciding a run is over, or knowing what a "mode" is — forbidden. Those are the app.

### Frozen vs app-owned

| FROZEN (write-once — never changes without a reflash) | APP-OWNED (changes freely, no reflash) |
|---|---|
| The frame-type number space (§5) | Run start/finish rules, modes, drills |
| Event frame layout (§7) + command/reply layouts (§8–9) | Per-mode timeouts (no gate timeout exists) |
| The shared-clock invariant (§4, §11) | Threshold *values* / presets (gate just accepts `SET_THRESHOLD`) |
| Command set + `gate_id` targeting (§8) | All split/lap/reaction interpretation |
| Gate-ID assignment & discovery flow (§10) | What the OLED shows, button meaning |

New feature later = new app interpretation of the **same** raw stream = no reflash. The
only thing that ever needs a USB reflash is a firmware *bug* (OTA is removed).

---

## 1. Topology

```
        ┌─────────── ESP-NOW broadcast (FF:FF:FF:FF:FF:FF) ───────────┐
        ▼                                                             ▼
   GATE (any)  ◀── time-sync beacons ──▶  GATE (any)  ◀── ... ──▶  GATE (any)
        ▲  every gate runs IDENTICAL firmware; whichever one the phone
        │  connects to is the BRIDGE for that session and relays the
        │  broadcast stream up over BLE. No gate is special.
     BLE GATT
        ▲
        │
     Phone (BLE central, owns ALL meaning)
```

- Every gate runs the **same binary**. Peripherals are feature-detected at boot.
- Gates broadcast over ESP-NOW to `FF:FF:FF:FF:FF:FF`; **no gate knows another gate's MAC**.
  Power on a new gate, it broadcasts, done — open-ended gate count, zero reflash.
- The phone connects to **one** gate (the **bridge**). The bridge relays every gate's events
  (and heartbeats) up over BLE, and relays targeted commands back down over ESP-NOW.
- Cross-gate timestamps are made comparable **on the gates** (§4), so the app never needs a
  per-gate clock offset — only a single display offset to the bridge (§11).

---

## 2. Conventions

- **Endianness:** little-endian for all multi-byte integers.
- **Time unit on the wire: raw `uint32` microseconds**, in the *shared gate-network clock*
  (§4). Wraps every ~71.6 min; the app uses signed-32 modular subtraction (`sdiff32`) for
  all interval math and re-syncs the display offset per session. **Rounding to ms is now an
  app concern** (the gate sends raw µs; the app rounds for display/storage). This is a change
  from v1, where the gate rounded — the gate no longer produces "result" numbers at all.
- **MTU:** all frames here are ≤ 20 bytes (default 23-byte ATT MTU) **except** `ASSIGN_IDS`
  for > 2 gates (§8); negotiate a larger MTU or chunk when gate count grows. The 2-gate
  product fits comfortably.
- `gate_id`: `0` = unassigned; `1..0xFE` = assigned; `0xFF` = "all gates" (command target only).

---

## 3. Services & characteristics (GATT)

Base UUID `7E5D00xx-9A1B-4C2D-8E3F-1A2B3C4D5E6F` — **reused from v1**, only PROTO_VER bumps.

| Characteristic | UUID | Props | v2 purpose |
|---|---|---|---|
| **Timing Service** | `7E5D0001-…` | — | container, advertised |
| Command | `7E5D0002-…` | Write w/ response (variable length) | phone → bridge command frames (§8) |
| Event | `7E5D0003-…` | Notify | bridge → phone: relayed events, heartbeats, replies (§7,§9,§10) |
| *LastResult* `7E5D0004` | — | Read+Notify | **legacy v1 only**, removed at cutover (§13) |
| *Status* `7E5D0005` | — | Read+Notify | **legacy v1 only**, removed at cutover (§13) |

**End state:** a single Command + single Event characteristic, everything discriminated by
the frame-type byte. `0004`/`0005` exist only so the v1 pipeline keeps working during phase-in.

**Advertising:** name `EqualSplit-Gx`, advertises the Timing Service UUID; the app scans by
**service UUID**, not name (any gate is a valid bridge).

---

## 4. The shared-clock invariant (closes the cross-gate gap)

Each gate's `micros()` is accurate relative to itself but boots at a different instant and
drifts. To make `gate2_micros − gate1_micros` a *true* interval, the gates agree on a shared
timebase **before any timestamp reaches the app**:

- Gates exchange periodic **`TIME_SYNC`** beacons over ESP-NOW (§10) and maintain a per-gate
  offset into one shared gate-network clock. The election/algorithm is **firmware-internal**
  and may evolve (it is gate↔gate only and never reaches the app).
- **Invariant the app relies on:** *every `micros` value in an event frame on the wire is
  already expressed in the shared gate-network clock.* Therefore any two event timestamps are
  directly comparable — the app subtracts them and gets a real interval, with **no per-gate
  offset bookkeeping**.

Consequences:
- **Same-gate intervals** (e.g. `BEAM_BREAK → BEAM_CLEAR` = dwell): exact, zero sync needed.
- **Cross-gate intervals** (split = `BEAM_BREAK(g2) − BEAM_BREAK(g1)`): valid because both are
  shared-clock — but **only once `time_synced` is set** (§9 caps). Until then the app treats
  cross-gate splits as untrustworthy and shows no number.
- **Transmission latency never affects accuracy:** timestamps are captured at edge time,
  before anything is sent. Late delivery = late *display*, never a wrong number. The app sorts
  by timestamp.

---

## 5. Frame-type number space (FROZEN, globally disjoint)

Byte 0 of every frame — on the Command channel, the Event channel, **and** ESP-NOW — is a
single disjoint registry, so the medium is never ambiguous. Ranges are also chosen to **avoid
the legacy v1 numbers** (commands `0x01–0x06`, events `0x10–0x15,0x1E`) so both contracts can
share the BLE channels during phase-in (§13).

| Range | Class | Members |
|---|---|---|
| `0x01–0x0F` | **Events** (gate-emitted, broadcast + relayed) | `0x01 BEAM_BREAK`, `0x02 BEAM_CLEAR`, `0x03 BUZZER_FIRED`, `0x04 BUTTON_PRESS`, `0x05–0x0F` reserved |
| `0x10–0x1F` | *(avoid — legacy v1 event types live here until cutover)* | — |
| `0x20–0x2F` | **Link / discovery** | `0x20 HEARTBEAT`, `0x21 TIME_SYNC` (gate↔gate, firmware-internal payload), `0x22–0x2F` reserved |
| `0x30–0x3F` | **Commands** (phone → gate; relayed gate → gate) | `0x30 ASSIGN_IDS`, `0x31 SET_THRESHOLD`, `0x32 BUZZER_FIRE`, `0x33 CLEAR_QUEUE`, `0x34 PING`, `0x35 GET_STATUS`, `0x36–0x3F` reserved |
| `0x40–0x4F` | **Replies** (gate → phone) | `0x40 PING_REPLY`, `0x41 STATUS_REPLY`, `0x42–0x4F` reserved |

`event_type` 0x03/0x04 are **reserved now even though the buzzer is unwired and buttons may be
absent** — that is the point of freezing: the hardware lights up later via an app update, no
reflash.

---

## 6. On-boot behaviour (every gate, identical)

- Feature-detect: try OLED I²C init → `has_display`; button code runs regardless (unwired pins
  never fire).
- Init ESP-NOW broadcast peer `FF:FF:FF:FF:FF:FF`; init NimBLE, advertise the service.
- `gate_id = 0` (unassigned), `threshold_cm = 100` (default).
- Emit `HEARTBEAT` (own MAC) over broadcast every ~1 s until assigned, then ~5 s keepalive.
- Begin `TIME_SYNC` participation (§4).

---

## 7. Event frame (FROZEN — 7 bytes, the heart of the contract)

Identical on ESP-NOW broadcast and when relayed verbatim to the app on the Event channel.

```
[0] frame_type   0x01 BEAM_BREAK | 0x02 BEAM_CLEAR | 0x03 BUZZER_FIRED | 0x04 BUTTON_PRESS
[1] gate_id      source gate (0 = unassigned)
[2..5] micros    uint32 LE — capture instant, SHARED gate-network clock (§4)
[6] flags        reserved, 0
```

- **`BEAM_BREAK` / `BEAM_CLEAR`** — both edges are emitted (debounced, signal-confirmed). The
  edge is in `frame_type`. The app ignores `BEAM_CLEAR` until a drill uses it (dwell /
  direction / agility) — no reflash to unlock those.
- **`BUZZER_FIRED`** — emitted when the buzzer actually fires, stamped with the gate `micros`
  at the fire instant. This is the **GO reference for reaction timing**:
  `reaction = BEAM_BREAK(start gate).micros − BUZZER_FIRED.micros`, one clock, no BLE latency
  in the path (≈ ±2–5 ms). Reserved and emitted by firmware now; becomes useful when the
  buzzer is physically wired (PCB respin) — app-only change.
- **`BUTTON_PRESS`** — a physical button edge, so the app can still offer a physical start.
  Just another raw event the app may act on or ignore.
- The gate emits events **forever**. No timeout, no run-end, no mode awareness.

Events are buffered in a **RAM ring queue (~64 events)** and **drained on BLE connect**, and
also notified live while connected. Each event carries its own timestamp, so late delivery
never corrupts data.

---

## 8. Command frames (FROZEN — phone → bridge; targeted ones relayed gate→gate)

Variable length, written with response. Byte 0 = opcode; commands that act on a specific gate
carry a **`target_gate_id`** in byte 1 (`0xFF` = all gates). The bridge executes the command
locally if it is the target and **re-broadcasts** it over ESP-NOW so remote gates self-match.

| Opcode | Name | Layout (after byte 0) | Action |
|---|---|---|---|
| `0x30` | `ASSIGN_IDS` | `count:u8`, then `count × {mac:6, id:1}` | each gate sets its `gate_id` if its MAC matches; bridge re-broadcasts |
| `0x31` | `SET_THRESHOLD` | `target:u8`, `distance_cm:u16` | target gate(s) set RAM `threshold_cm` |
| `0x32` | `BUZZER_FIRE` | `target:u8`, `duration_ms:u16`, `pattern:u8` | target gate drives `BUZZER_PIN`, emits `BUZZER_FIRED` at fire instant |
| `0x33` | `CLEAR_QUEUE` | `target:u8` | target gate(s) empty the RAM event queue (app calls at session start) |
| `0x34` | `PING` | `app_micros:u32` | **connected gate only** (no target) — reply `PING_REPLY` immediately |
| `0x35` | `GET_STATUS` | `target:u8` | target gate(s) reply `STATUS_REPLY` |

`ASSIGN_IDS` needs no `target` byte — the MAC list *is* the targeting. For 2 gates it is
`1 + 1 + 2×7 = 16` bytes (within MTU); larger fleets need MTU negotiation or chunking.

There is **no** `ARM`, `MODE`, `START_SEQUENCE`, or `RESET` — arming, modes, sequences, and
resets are entirely app-side now.

---

## 9. Reply frames (FROZEN — gate → phone, on the Event channel)

**`PING_REPLY` (`0x40`, 9 bytes):**
```
[0] 0x40
[1..4] echoed app_micros (u32 LE)   ← lets the app match request↔reply, compute RTT
[5..8] gate_micros      (u32 LE)    ← bridge's shared-clock micros at reply
```
The app anchors the display offset on the **minimum-RTT** sample (`offset` such that
`phone_ms ≈ gate_us/1000 − offset`), exactly as today's `clockSync.ts`, but keyed off this
reply instead of the Status characteristic.

**`STATUS_REPLY` (`0x41`, 8 bytes):**
```
[0] 0x41
[1] gate_id
[2..3] threshold_cm (u16 LE)
[4] battery_pct     (0xFF = not sensed / n/a)
[5] queue_depth
[6] fw_ver
[7] caps            bit0 has_display, bit1 has_buttons, bit2 buzzer_wired, bit3 time_synced
```

---

## 10. Discovery, ID assignment & time sync (link frames)

**`HEARTBEAT` (`0x20`, 7 bytes)** — gate → broadcast; bridge relays to app:
```
[0] 0x20   [1..6] sender MAC (6)
```
The app collects heartbeats (each unique MAC = a discovered gate) and assigns IDs.

**ID assignment flow (RAM-only, fresh each session):**
1. Gates boot `gate_id = 0`, heartbeat their MAC.
2. App (via bridge) sees the set of MACs, decides IDs, sends `ASSIGN_IDS`.
3. Bridge sets its own id and re-broadcasts; remote gates set their id on MAC match.
4. App confirms by observing each gate emit events / `STATUS_REPLY` with its new id (ESP-NOW
   is unacked — re-send `ASSIGN_IDS` until confirmed).

IDs are **not persisted and not self-assigned** — always app-assigned, fresh per session.

**`TIME_SYNC` (`0x21`)** — gate ↔ gate ESP-NOW only, **never relayed to the app**. Carries the
sender's shared-clock estimate; exact payload/algorithm is firmware-internal (the app never
parses it). Only the *type number* is frozen, to keep the namespace disjoint.

---

## 11. Clock model summary

- **Gate-network clock (gates):** maintained via `TIME_SYNC`; all event `micros` on the wire
  are in it. This is the ONE hard dependency for cross-gate math.
- **Display offset (app):** one `PING`/`PING_REPLY` to the bridge maps gate-network µs → the
  phone clock, only so the UI can show a running timer. Re-PING occasionally for phone-clock
  drift. **This offset never affects a recorded interval** — recorded intervals are always
  `event.micros − event.micros` differences in the gate-network clock.
- **Reaction:** `BEAM_BREAK(start).micros − BUZZER_FIRED.micros` (both gate-clock physical
  instants). **Split:** `BEAM_BREAK(g2).micros − BEAM_BREAK(g1).micros`.

### 11.1 Interval math (FROZEN rule — wrap-safe, mandatory in the run engine)

Every interval — split, reaction, dwell — is computed with **signed-32 modular subtraction**,
never a naive subtract. This must live in the engine, not be assumed from the convention note:

```
interval_us = sdiff32(later_micros, earlier_micros)
// sdiff32(a, b): d = (a - b) >>> 0; if (d >= 0x80000000) d -= 0x100000000; return d
```

- The gate-network µs counter is `uint32` and wraps every **~71.6 min**. `sdiff32` returns the
  correct small positive interval **even when `later_micros < earlier_micros` numerically**
  across a wrap, as long as the true interval is < 2³¹ µs (≈ **35.8 min**) — always true for a
  run. Worked: g1 break at `0xFFFFFF00`, g2 break at `0x00000100` → naive `g2 − g1` in JS
  doubles = **−4 294 966 784 (WRONG)**; `sdiff32` = `0x200` = **512 µs (CORRECT)**. The engine
  MUST use `sdiff32` for split **and** reaction, never `a − b`. (This is the bug that only
  surfaces ~71 min into a session — covered here, not left to chance.)
- **Same-gate intervals** are valid with **zero** cross-gate sync — `BEAM_BREAK→BEAM_CLEAR`
  dwell, **and reaction** (the buzzer and the start-gate beam are the *same gate*, so
  `BEAM_BREAK − BUZZER_FIRED` needs no `time_synced`).
- **Cross-gate intervals** (a split across two gates) require **`time_synced`** (§9 caps); the
  engine withholds the number until that bit is set.

---

## 12. APP-OWNED semantics (NOT frozen — here for reference, changes without reflash)

These live in the app and are recorded here only so we agree on the *initial* behaviour. They
are **not** part of the wire contract and may change anytime.

- **Run engine — Mode 1 (gate-to-gate):** first `BEAM_BREAK` on the **start** gate starts the
  run; `BEAM_BREAK` on the other gate finishes it; `BEAM_CLEAR` ignored; the app debounces /
  pairs edges.
- **Timeouts:** *per-mode app config*, not a single hardcoded value. Mode 1 defaults to ~30 s
  (trivially changeable); some future modes have none. **No timeout exists in firmware.**
- **Mode 2 (reaction):** **shelved until the buzzer is physically wired.** Until then it is
  hidden behind a dev flag and clearly labelled unreliable — the phone-beep start is
  contaminated by unmeasurable iOS audio-output jitter (see `docs/LATENCY.md`), so we will not
  show athletes a number we know is wrong. `BUZZER_FIRED` lights it up cleanly post-respin with
  **no reflash**.
- **`BUTTON_PRESS` / `BEAM_CLEAR`:** available raw events; the app uses them when a drill needs
  them, ignores them otherwise.
- All split / lap / drill interpretation is app-side, against the frozen 7-byte event stream.

### 12.1 Standalone consumer (gate-side, no phone required)

A shipped gate MUST time a basic run with **no phone**. This is a small **v2-stream consumer
that lives on the gate** — architecturally identical to the app (it reads the same frozen event
stream), **not** the old v1 machinery. It is deliberately minimal and never changes when app
modes are added (modes are app-side by definition): the gate knows exactly one thing forever —
the basic gate-to-gate split. Because the gate and the app read the **same** stream, they
cannot disagree.

- **Where it runs:** only on gates with a **display + buttons** (feature-detected). A bare gate
  (no OLED/buttons) does nothing standalone; it still **broadcasts its beam events** so a display
  gate can compute the split. Standalone assumes **2 gates** (own + one other).
- **Arming:** a **button press** arms the local consumer. No wire command, no "mode" — just local
  UI state on the gate.
- **Run logic (no `gate_id` needed):** standalone gates are never `ASSIGN_IDS`'d, so ids stay 0.
  The consumer keys on **origin, not id**: its **own** locally-detected edge vs an edge **received
  over ESP-NOW** (distinct code paths). After arming, the first break (either source) **starts**;
  the first break from the *other* source **finishes**. Direction-agnostic.
- **Split:** `interval = sdiff32(finish.micros, start.micros)` — one subtraction, both timestamps
  already in the shared gate-network clock (§4, §11.1). Requires `time_synced`; until the gate has
  converged it shows **"SYNCING"**, never a wrong number. The master is always synced; a follower
  is ready once its first good `TIME_SYNC` lands (seconds after boot).
- **Display + local timeout:** live elapsed timer while running, split/total on finish, on the
  OLED. A **local display timeout** (~30 s armed-without-finish → idle) lives in this consumer.
  This does **not** contradict "no timeouts in firmware" (§12) — that rule constrains the *event
  stream / emitter* (edges forever, no run-end); a local display is free to time out, exactly like
  the app's per-mode timeouts.
- **Every gate broadcasts its own beam events** (not only relays received ones), so other gates'
  standalone consumers — and the bridge's BLE relay — all see them. Frame format unchanged; this
  is simply the broadcast model of §7 made uniform across gates.

---

## 13. Phased migration & legacy coexistence (Q2 — working timer must not go dark)

The transition firmware **dual-emits**:
- **Legacy v1** — `STATE/GO/SPLIT/FINISH/NOTICE` (`0x10–0x15,0x1E`) on `Event 0003`, plus
  `LastResult 0004` / `Status 0005`, plus opcodes `0x01–0x06` on `Command 0002`. The current
  app pipeline keeps working unchanged.
- **v2 raw** — the new frame-type space on the **same** `Command 0002` / `Event 0003` (number
  spaces are disjoint, §5) plus ESP-NOW broadcast.

The app runs the **old pipeline by default** and the **new raw pipeline behind a dev flag**,
consuming the *same physical events* so they can be compared live. After the acceptance test
(§14) passes, a later firmware **drops** the legacy emit, `0004`/`0005`, and opcodes
`0x01–0x06`; `PROTO_VER` becomes **2** only and we are at the clean end-state GATT (§3).

> Legacy reserved numbers (do not reuse in v2): commands `0x01–0x06`; events `0x10–0x15,0x1E`.

---

## 14. Cutover acceptance test (the green light)

Before deleting the old gate-side path, run **both** pipelines against the **same** physical
events and confirm the new raw-event splits agree with the old gate-computed splits within
**≈ ±4–5 ms** (the band is dominated by TF-Luna 250 Hz frame quantization, not the protocol).
Use the **ball-drop rig** for repeatable edges. That agreement — not a vibe — is the signal to
cut over.

---

## 15. Pin map (locked) & peripherals

- **TF-Luna LiDAR:** UART `Serial2`, `IO16` RX / `IO17` TX (250 Hz).
- **OLED (SH1106, I²C):** existing pins (`SDA 21 / SCL 22`). Feature-detected; **status only**
  (`gate_id`, link, battery) — **never** splits, the gate computes nothing.
- **Buttons:** existing GPIO (`BUTTON1 = 15`, `BUTTON2 = 4`); a press emits `BUTTON_PRESS`
  (`0x04`); unwired pins never fire.
- **`BUZZER_PIN = GPIO 25`** — declared now, physically wired at the PCB respin. Output-safe,
  no strapping baggage, DAC-capable for direct tone.
- **Battery:** **confirmed — no battery-sense hardware** on the board (and none planned).
  `STATUS_REPLY.battery_pct` stays `0xFF` (reserved, **not** dropped — a later board respin can
  light it up with no contract change).
- **Radio (MUST — non-optional, firmware invariant):** every gate MUST call
  `WiFi.setSleep(false)` (disable STA modem-sleep) at boot, and MUST keep it disabled. Default
  modem-sleep parks the radio between the gate's *own* transmissions, so **all unsolicited
  ESP-NOW RX is silently dropped** — heartbeats, `TIME_SYNC`, relayed events — and only
  transactional request/reply survives. This is invisible: sends still report success, the gate
  just never hears anything, so election never fires and the gate network never forms. (It is
  exactly why v1's transactional unicast worked and v2's passive broadcast did not.) All gates
  MUST also pin one shared WiFi channel (`esp_wifi_set_channel(ch, WIFI_SECOND_CHAN_NONE)` +
  `peer.channel = ch`), **re-asserted after BLE init** on the bridge (coex can re-enable
  power-save). A rewrite that drops either silently breaks the entire gate network with no error
  — treat both as load-bearing as the shared-clock invariant (§4).
- **Power / decoupling (respin — required):** brownouts (`E BOD: Brownout detector was
  triggered`) recur under v2 radio duty on the current build, worse on marginal USB/cable.
  Add bulk + local decoupling at the PCB respin — e.g. a **~470 µF** electrolytic on the 3V3
  rail plus a **100 nF** ceramic right at the ESP32 `3V3`/`EN` pins — to absorb Wi-Fi/BLE TX
  current spikes. Firmware mitigations (TIME_SYNC ping at **1 s**, heartbeat 5 s post-assign)
  cut the duty but are not a substitute for the cap.

---

## 16. Firmware logistics

- Single **symmetric** binary, one source of truth at **`firmware/` in the repo**. Flash from
  there going forward (not the OneDrive folder); delete the scattered copies.
- **Gate-2 live source (verified):** `firmware/gate2_no_ota/gate2_no_ota.ino` — newest by mtime
  (2026-06-13 01:07), **byte-identical** to `Downloads/gate2_no_ota/` (md5 `7d218143…`), already
  OTA-free, and its ESP-NOW peer (`gate1MAC B4:BF:E9:32:DA:64`) pairs with `gate1_ble`'s
  `gate2MAC` — i.e. it is the matching half of the live pair. Older/larger strays
  (`Downloads/gate2/gate2.ino` 8052 B, `gate267*`) are superseded. **The symmetric-binary merge
  is still gated on Louis's explicit OK that this is what's physically flashed on gate 2.**
- **OTA removed** (ElegantOTA + its WiFi/partition scaffolding). A firmware bug fix = USB cable.
- BLE connection-interval request (deferred ~15 ms, Apple-safe) from the prior work is retained
  — it tightens the app↔bridge `PING` RTT, hence the display offset, nothing more.

---

## 17. Versioning

`proto_ver` / `fw_ver` reported in `STATUS_REPLY` (and legacy `Status` during transition).
End-state `PROTO_VER = 2`. Bump on any frozen-layout change. The app refuses to interpret an
unknown `proto_ver`.

---

## 18. F2 freeze checklist (the write-once gate ships when ALL pass)

The single symmetric `firmware/gate/gate.ino` is "done — never touch again" only when every
item holds. Firmware freezes into sold units (USB-only updates), so this is the real gate.

**Functional**
- [ ] One binary flashes and runs on **both** physical gates (feature-detect: OLED present vs
      absent); either gate can be the BLE bridge (whichever the phone connects to).
- [ ] Lowest-MAC election settles within a couple seconds of both powering; roles correct.
- [ ] Radio invariants present: `WiFi.setSleep(false)` + pinned channel, re-asserted after BLE
      init (§15). *(F1 proved omitting these silently kills the gate network.)*
- [ ] App v2 Timer: bring-up → arm → time → save, across a full session.
- [ ] Standalone (no phone): button arms; split shown on OLED; `SYNCING` until time-synced;
      local display timeout resets a stale arm.

**Correctness**
- [ ] Ball-drop agreement ≤ ±4–5 ms via **both** the app **and** the standalone consumer.
- [ ] **Wrap boundary:** a run and a standalone run that straddle the ~71.6-min `micros` wrap
      still give the correct split (firmware standalone MUST use `sdiff32`; TIME_SYNC offset math
      survives the wrap). This is *guaranteed* to happen on an always-on unit — test it, don't
      assume it.

**Stability (the write-once threat — standalone units are unwatched)**
- [ ] **No unexplained resets across a 20+ rep session.** A mid-session reset is invisible to a
      standalone athlete. Capture `rst:` reason on any reset; root-cause before freeze
      (brownout vs firmware crash vs coex).
- [ ] Long-idle soak (hours powered, no runs) with no reset and no RX degradation.
- [ ] Brownout mitigation in place (decoupling caps on the respin, §15) — `setSleep(false)`
      raises steady-state draw, so power margin must be real, not marginal-USB luck.

**Hygiene / provenance**
- [ ] v1 fully deleted (STATE/GO/SPLIT/FINISH, `0004`/`0005`, opcodes `0x01–0x06`, the ESP-NOW
      `GateData` path, Mode 1/2 state machines); `PROTO_VER 1` gone, `fw_ver = 2`.
- [ ] Boot build marker present (`FW_BUILD` + `__DATE__`/`__TIME__`), bumped for this build.
- [ ] Every gate broadcasts its own beam events (uniform, for other gates' standalone consumers).
