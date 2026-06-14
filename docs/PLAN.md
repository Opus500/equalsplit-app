# EqualSplit App — v1 Plan

A phone app that connects to the EqualSplit gates over BLE, selects/starts the timing modes,
shows the time live during a run, and stores results across sessions. Stack: React Native /
Expo / SQLite (local-first), reusing the Convi toolchain. The BLE wire format lives in
[BLE-CONTRACT.md](./BLE-CONTRACT.md).

## Decisions locked

| Decision | Choice | Why |
|---|---|---|
| Phone ↔ gate link | **BLE** to Gate 1 only | phones can't do ESP-NOW; Gate 1 is already the hub/timekeeper |
| Wire time unit | **`uint32` ms**, rounded at source | exact parity with OLED / `RunRecord`; app and gate never disagree |
| Mode 2 start | **both** button-release **and** phone random auto-GO | gate always owns T0, so both are accurate; phone never in timing path |
| Storage | **local-first `expo-sqlite`**, Supabase sync deferred | the track often has no signal; results must never be lost |
| Platform | **iOS + Android**, bring up BLE on **iOS first** | reuse Convi's Apple account; cloud EAS build needs no Mac |
| Build type | **Expo dev client** (not Expo Go) | `react-native-ble-plx` has native code |

## 1. Architecture

Gate 1 = the single hub and timekeeper (LiDAR + OLED + buttons + ESP-NOW peer of Gate 2),
plus a new BLE peripheral role. Gate 2 is unchanged and never talks to the phone. The phone
is a BLE central that arms/initiates and observes, storing every finished run locally. The
authoritative time is computed once on Gate 1 (`processResult()`, with its ESP-NOW one-way
latency correction) and simply carried over BLE.

## 2. BLE protocol

See [BLE-CONTRACT.md](./BLE-CONTRACT.md). Summary: one Timing Service with Command (write),
Event (notify), LastResult (read+notify), Status (read+notify). Commands mirror the hardware
buttons; events mirror the Mode 1 / Mode 2 state machine.

## 3. Live timer

- Capture `t0 = performance.now()` (monotonic) on `START` (Mode 1) or `GO` (Mode 2); render
  `performance.now() − t0` at ~15 ms; freeze a split readout on `SPLIT`; **snap** to the
  gate's `total_ms` on `FINISH`.
- The running clock is cosmetic; the stored/shown final number is always the gate's.
- Drift: BLE latency starts the local clock a touch late (reads low, snaps up at finish —
  acceptable; optionally back-date with `t0_us` + a `PING` latency estimate). Use
  `performance.now()` not `Date.now()`; compute from `t0`, never accumulate ticks; keep the
  screen awake (`expo-keep-awake`). Never re-time on the phone.

## 4. Storage — local-first SQLite

`expo-sqlite`, sync deferred. Schema:

```sql
sessions(id TEXT PK, name, created_at, default_mode, note, location, synced DEFAULT 0);
runs(id TEXT PK, session_id REFERENCES sessions(id), mode, run_index, started_at,
     total_ms, split1_ms, split2_ms, status, raw_json, created_at, synced DEFAULT 0);
```

A session is app-defined (a training block). Each `FINISH` appends a run. The `synced`
column makes a future Supabase backup a no-migration change.

## 5. Screens (v1)

1. **Connect / Pair** — scan by Timing Service UUID, connect, show state + finish-link + fw version, reconnect.
2. **Timer (mode select + live)** — Mode 1 / Mode 2 segmented; Arm; Mode 2 "Start (random)" + note the gate button also works; big live timer; split readout; on finish show total (+ splits); Save / Discard / Next.
3. **History** — sessions → session detail (runs + splits + best/last); delete.
4. **Settings / About + Donate** — donate link-out, app + protocol version, gate info, units.

Bottom tabs (Timer / History / Settings) + a connection chip → Connect.

## 6. Expo dev-build setup (iOS first)

1. `npx create-expo-app@latest` (TypeScript).
2. `npx expo install react-native-ble-plx expo-dev-client expo-sqlite expo-keep-awake` + navigation.
3. `app.config.ts`: ble-plx config plugin; iOS `NSBluetoothAlwaysUsageDescription`
   (+ `NSBluetoothPeripheralUsageDescription`); Android `BLUETOOTH_SCAN` / `BLUETOOTH_CONNECT`
   with `neverForLocation`.
4. `eas login` → `eas build:configure`; add a `development` profile (`developmentClient: true`,
   `distribution: internal`).
5. **iOS:** `eas device:create` (register the iPhone), `eas build -p ios --profile development`,
   install via QR (ad-hoc). No Mac needed for the cloud build.
6. **Android (later):** `eas build -p android --profile development` → install APK.
7. `npx expo start --dev-client`. Use a **physical iPhone** — the Simulator has no Bluetooth.

## 7. Build order

0. **Firmware (gating):** minimal BLE service on Gate 1 (Status + Event + Command), even stubbed; validate ESP-NOW coexistence.
1. **Connect & log** — dev build → scan/connect to `EqualSplit-G1`, read Status, subscribe Event, dump raw bytes. *(← current step)*
2. **BLE contract layer** — typed `bleClient` (connect, `sendCommand`, parsers → TS types, hook/emitter) + a console UI to fire commands.
3. **Timer MVP (no DB)** — arm + show raw `FINISH` numbers; confirm app == OLED on a real Mode 1 and Mode 2 run.
4. **Live timer** — monotonic clock, start on START/GO, freeze on SPLIT, snap on FINISH, keep-awake.
5. **Storage** — `expo-sqlite` schema + Save/Discard + sessions.
6. **History screen**.
7. **Settings + Donate** + robustness (LastResult re-read on reconnect, NOTICE handling, finish-link indicator, empty states).
8. **Deferred (v1.1+):** Supabase sync (reuse Convi auth), athlete management, leaderboards, Cloudinary/photos.
