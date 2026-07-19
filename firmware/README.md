# EqualSplit gate firmware — single source of truth

**Flash from here.** This directory is the only place gate firmware should live. The
scattered copies under `OneDrive/Documents/Arduino` and `Downloads` are being removed to end
the "which copy is live?" divergence — do not recreate copies there. Both canonical sketches
below were verified byte-identical to what is physically flashed before any cleanup.

## Canonical sources (live, flashed)

| Sketch | Role | MAC | Notes |
|---|---|---|---|
| `gate1_ble/gate1_ble.ino` | **Gate 1** — start gate, BLE bridge, timekeeper | `B4:BF:E9:32:DA:64` | NimBLE + ESP-NOW. MAC read from eFuse (esp_efuse_mac_get_default) and verified 2026-07. |
| `gate2_no_ota/gate2_no_ota.ino` | **Gate 2** — finish gate | `30:76:F5:A6:43:BC` | ESP-NOW only; confirmed live by Louis (flashed, Mode-1 split correct). Already OTA-free. |

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
