# EqualSplit App

Phone app for the EqualSplit sprint-timing gates. Connects to the **start gate (Gate 1)**
over BLE, selects/starts the timing modes, shows the time live, and stores results.

- Plan: [docs/PLAN.md](docs/PLAN.md)
- BLE wire contract (shared with firmware): [docs/BLE-CONTRACT.md](docs/BLE-CONTRACT.md)
- Gate firmware: [firmware/](firmware/)

## Stack

Expo SDK 56 · React Native 0.85 · `react-native-ble-plx` · `expo-sqlite` (local-first) ·
`expo-audio` (start cues). BLE requires a **dev client** (not Expo Go) on a **physical
device** (no simulator BLE). `expo-av` no longer exists on SDK 56, so audio uses `expo-audio`.

## Current state — v1 timing UI

Three tabs (`App.tsx` tab switcher, no nav library):

- **Timer** ([src/screens/TimerScreen.tsx](src/screens/TimerScreen.tsx)) — a two-gate run on
  the v2 raw-event engine ([src/ble/V2Provider.tsx](src/ble/V2Provider.tsx)): the session brings
  itself up (discover → assign → time-sync → ping), Arm gate waits app-side for the start-gate
  break, the live timer runs from the display offset, and the saved total is the gate-1→gate-2
  split in the gates' shared clock. The v1 Timer (Mode 1/Mode 2 opcodes, STATE/GO/FINISH,
  phone-beep cues) was deleted in September 2026: the firmware on every unit dropped that
  surface at the July freeze. Reaction mode returns with the gate buzzer at the PCB respin;
  [docs/LATENCY.md](docs/LATENCY.md) is the record of the v1-era phone-beep model. The sound
  assets ([assets/sounds/](assets/sounds/), [scripts/gen-sounds.mjs](scripts/gen-sounds.mjs))
  and `expo-audio` are currently unused and slated for removal with the rest of the v1 plumbing.
- **History** ([src/screens/HistoryScreen.tsx](src/screens/HistoryScreen.tsx)) — sessions
  (one per day) → run list with splits and session best.
- **Debug** ([src/screens/DebugScreen.tsx](src/screens/DebugScreen.tsx)) — the original
  connect-and-log screen, kept for bring-up/protocol debugging.

The shared BLE connection lives in [src/ble/GateProvider.tsx](src/ble/GateProvider.tsx)
(`useGate()`); typed event parsing in [src/ble/events.ts](src/ble/events.ts); storage in
[src/db/database.ts](src/db/database.ts). On connect it requests a ~15ms connection interval
(Android `ConnectionPriority.High`; on iOS the gate dictates the interval).

> Adding `expo-audio`/`expo-asset` are native changes — **rebuild the dev client** before running.

## Run it (iOS first)

Prereqs: an Apple Developer account and an iPhone (no Mac required — EAS builds in the cloud).

```bash
npm install                      # already done
eas login
eas device:create                # register your iPhone (open the link on the phone)
eas build -p ios --profile development   # install the resulting build via the QR code
npm start                        # = expo start --dev-client; open in the installed app
```

With a Mac + Xcode you can instead run `npm run ios`. Android dev build later:
`eas build -p android --profile development`.

## Next steps

Done: typed BLE layer, Timer + live timer, audio cues, SQLite storage, history.
Remaining (see [docs/PLAN.md](docs/PLAN.md)): Settings/About + Donate screen, robustness
(reconnect/LastResult re-read, NOTICE surfacing, false-start handling), then deferred v1.1
(Supabase sync reusing Convi, athlete management, leaderboards).
