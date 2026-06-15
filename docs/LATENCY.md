# Mode 2 reaction-latency compensation

The Mode 2 "GO" is cued by a beep **on the phone**, which trails the gate's
authoritative GO by the beep latency (BLE delivery + iOS audio buffering). The
athlete reacts to the late beep, so the gate's raw reaction (`split1 = GO→Gate1`)
is inflated by that latency, and the latency is **jittery** run-to-run (you
measured ≈223 ms mean). A fixed subtraction can't track the jitter. This is the
record of what was implemented to **minimise and stabilise** the residual error,
and how to **measure** it on device.

> Honest note: these numbers must be produced on your hardware. The app now
> computes them (Settings → "Measured latency", and `console.log` lines). The
> tables below have blanks to fill in from your device — nothing here is invented.

## The methods

### 1. Clock sync via PING / `t0_us` (the main win)
NTP-style offset estimate between the gate's `micros()` clock and the phone's
`performance.now()` clock:

- `syncClock()` sends `PING` (`0x06`) repeatedly. Each PING makes the gate refresh
  the Status characteristic's `gate_micros` and notify. We record the round-trip
  time and take the **minimum-RTT** sample (least queuing asymmetry) as the anchor:
  `offset` such that `phone_ms = gate_us/1000 − offset` (see `src/ble/clockSync.ts`).
  Gate micros is uint32 (wraps ~71 min) → elapsed time uses signed-32 modular math;
  we re-sync on every (re)connect.
- Per run we then map the gate's GO (`t0_us` from the GO event, contract §5) into
  phone time and compute the **actual** beep latency for that run:

  ```
  tGoPhone   = gateUsToPhoneMs(t0_us)          # gate GO in phone time
  bleOneway  = tRecv      − tGoPhone           # gate GO → phone receives GO event
  proc       = tPlay      − tRecv              # event receipt → go.play() call
  audioGap   = tAudioStart− tPlay              # play() → audio actually advances
  beepLatency= tAudioStart− tGoPhone           # = bleOneway + proc + audioGap
  trueReaction = raw_split1 − beepLatency
  ```

  Because we **measure** `beepLatency` each run rather than guessing a constant,
  the run-to-run BLE jitter is *cancelled*, not left in the result. (Correction
  mode "synced"; falls back to the fixed offset if no anchor.)

### 2. Tighten audio playback
- Warm the audio session + decoder at mount, and **prime** again at `go-imminent`
  (a brief silent play, then re-seek to 0) so the GO `play()` is a warm, **no-await**
  start (only `go.play()` runs on the GO event; no `seekTo`/awaits in the path).
- Measure the `play()`→sound gap (`audioGap`) per run via the `playbackStatusUpdate`
  callback, with `updateInterval: 16 ms` (so audioGap precision ≈ ±16 ms, vs the
  old ±50 ms).

### 3. Reduce BLE delivery jitter
- The gate firmware already requests a 7.5–15 ms connection interval on connect
  (`updateConnParams`). **iOS does not expose the negotiated interval to apps**, so
  it cannot be logged directly; the PING **RTT (min/med/max)** in Settings is the
  closest observable proxy.
- Not yet done (needs a firmware tweak): `WRITE_NR` on the command characteristic
  to allow write-without-response PINGs (slightly lower RTT). The dominant GO path
  is a gate→phone notification, which the app cannot reprioritise; the gate already
  sends GO as a standalone notify.

### 4. Better latency measurement
- Per-run breakdown (`bleOneway`, `proc`, `audioGap`, `beepLatency`) is recorded
  for the last 40 runs; Settings shows **mean / stdev / min–max / n** for each. The
  **stdev** is the figure of merit: it's the run-to-run jitter the synced correction
  removes.

## Final approach

Default = **synced per-run correction**: subtract the measured `beepLatency` for
each run, computed from clock sync + the audio-start timestamp. Fixed-offset mode
is kept as a fallback / comparison. Raw gate values are always stored, with the
applied offset per run, so anything can be recomputed.

## How to measure (do this on device)

1. Connect; wait for Settings → "Reaction correction" to show **Synced · RTT …**
   (auto-syncs on connect; "Re-sync" to repeat). Record RTT min/med/max.
2. Do ~10 Mode 2 runs in **Fixed** mode, then ~10 in **Synced** mode.
3. Read Settings → "Measured latency": record **mean** and **sd** of *Beep latency*,
   *BLE one-way*, *Audio gap*. Also watch `[lat] …` and `[FINISH …]` in the Metro log.

### Results (fill in from your device)

| Metric | Before (fixed 150 ms) | After (synced per-run) |
|---|---|---|
| Mean applied correction (ms) | 150 (constant) | _____ |
| Beep-latency mean (ms) | _____ | _____ |
| **Beep-latency stdev (ms)** — the jitter | _____ | _____ |
| BLE one-way mean / sd (ms) | _____ | _____ |
| Audio gap mean / sd (ms) | _____ | _____ |
| PING RTT min/med/max (ms) | _____ | _____ |

Interpretation:
- **Fixed** leaves the full *beep-latency stdev* in your reaction times.
- **Synced** removes the per-run beep latency, so the residual reaction error ≈
  **sync error (~RTT/2) + audio-gap quantization (~16 ms)**. The win is real iff the
  synced residual (≈ RTT/2 + 16 ms) is meaningfully smaller than the fixed
  beep-latency stdev. If RTT is large/jittery, sync helps less — tighten it first.

## Limitations (honest)

- Audio-start time is bounded by `updateInterval` (~16 ms); not the true hardware
  output instant (expo-audio doesn't expose it).
- Clock-sync error is ~RTT/2 of the min sample; dominated by the iOS connection
  interval, which the app can't read or force.
- The only way to fully remove phone-beep latency from reaction timing is a
  **buzzer on the gate** firing at `startTimeUs` (gate-cued start). The clock-synced
  correction is the best achievable while the cue stays on the phone.
