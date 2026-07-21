# EqualSplit gate firmware — single source of truth

**Flash from here.** This directory is the only place gate firmware should live. The
scattered copies under `OneDrive/Documents/Arduino` and `Downloads` are being removed to end
the "which copy is live?" divergence — do not recreate copies there. Both canonical sketches
below were verified byte-identical to what is physically flashed before any cleanup.

## Canonical sources

| Sketch | Role | MAC | Notes |
|---|---|---|---|
| `gate/gate.ino` | **F2 symmetric write-once binary** — one flash for BOTH gates | (feature-detects) | v2-only. Election + standalone consumer + SET_PARAM/NVS + every-gate-broadcasts-own-events. **NOT yet compiled/flashed** — needs a hardware validation pass against contract §18. |
| `gate1_ble/gate1_ble.ino` | Gate 1 (transition) — start gate, BLE bridge, timekeeper | `B4:BF:E9:32:DA:64` | v1+v2 dual-emit, `FW_BUILD gate1-b8`. Currently flashed. Superseded by `gate/` at freeze. |
| `gate2_no_ota/gate2_no_ota.ino` | Gate 2 (transition) — finish gate | `30:76:F5:A6:43:BC` | v1+v2 dual-emit, `FW_BUILD gate2-b8`. Currently flashed. Superseded by `gate/` at freeze. |

**F2 (`gate/gate.ino`) is the endgame:** the same binary runs on both units (OLED/buttons
feature-detected), determines its own time-master role by lowest-MAC election, broadcasts its
own raw beam events, times a run standalone with no phone (§12.1), and accepts `SET_PARAM` with
NVS persistence (§8.1). Flash it to both, validate via the app **and** standalone, then freeze
and drop the two transition sketches. It is uncompiled as written — compile, flash, and work the
§18 checklist before trusting it on hardware.

The two pair: `gate1_ble` sends to `gate2MAC 30:76:F5:A6:43:BC`; `gate2_no_ota` sends to
`gate1MAC B4:BF:E9:32:DA:64`. Hardware is symmetric (identical TF-Luna `Serial2 16/17`,
threshold 100, 15 ms debounce); Gate 2 has no OLED/buttons populated — hence boot-time
feature detection in v2.

## Status: v1 (legacy) → v2 (write-once) migration in progress

- **Now:** these are the proven **v1** firmwares (`PROTO_VER 1`, asymmetric: Gate 1 computes
  results, Gate 2 unicasts its delta). The app's live pipeline runs against them.
- **Plan:** `../docs/BLE-CONTRACT.md` (v2, **locked**) + the v2 firmware plan. We **add** the
  v2 raw-event layer alongside the proven timing path (dual-emit, each gate flashed once), run
  both pipelines in parallel, and at cutover **delete** the legacy code — collapsing both into
  one **symmetric** write-once binary. The proven timing path is not rewritten up front.
- **OTA:** removed. A firmware bug fix = USB cable.

## Pin map (locked — see contract §15)

- TF-Luna LiDAR: `Serial2` `IO16` RX / `IO17` TX (250 Hz)
- OLED SH1106 I²C: `SDA 21 / SCL 22` (feature-detected; Gate 2 has none)
- Buttons: `BUTTON1 = 15`, `BUTTON2 = 4` (feature-detected)
- `BUZZER_PIN = GPIO 25` (declared; wired at PCB respin)

## Housekeeping

- `gate1_no_ota/` is the **pre-BLE Gate-1 baseline** — superseded by `gate1_ble`, not flashed
  on anything. Kept only as historical reference; safe to remove (it's in git history).
