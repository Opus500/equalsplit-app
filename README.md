# EqualSplit App

Phone app for the EqualSplit sprint-timing gates. Connects to the **start gate (Gate 1)**
over BLE, selects/starts the timing modes, shows the time live, and stores results.

- Plan: [docs/PLAN.md](docs/PLAN.md)
- BLE wire contract (shared with firmware): [docs/BLE-CONTRACT.md](docs/BLE-CONTRACT.md)
- Gate firmware: [firmware/](firmware/)

## Stack

Expo SDK 56 · React Native 0.85 · `react-native-ble-plx` · `expo-sqlite` (local-first).
BLE requires a **dev client** (not Expo Go) on a **physical device** (no simulator BLE).

## Current state — build-order step 1: connect-and-log

`App.tsx` is a throwaway BLE bring-up screen: scan → connect to `EqualSplit-G1` →
read `Status` → stream raw `Event` notifications → fire each command and watch the gate.
It exists to prove the dev build + BLE + permissions work before any real UI is built.

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

See the build order in [docs/PLAN.md](docs/PLAN.md): step 2 = typed BLE event layer,
step 3 = Timer MVP, step 4 = live timer, step 5 = SQLite storage, step 6 = history,
step 7 = settings/donate + robustness.
