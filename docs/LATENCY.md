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

## VERDICT (measured 2026-06-15): phone-cued reaction correction is NOT salvageable

Real per-run data settled this. Five synced Mode 2 runs, raw → corrected (correction):

| raw (s) | corrected (s) | correction (ms) |
|--:|--:|--:|
| 0.512 | 0.145 | 367 |
| 0.464 | 0.153 | 311 |
| 0.475 | 0.222 | 253 |
| 0.634 | 0.144 | 490 |
| 0.618 | 0.134 | 484 |

- The applied correction swung **253–490 ms (sd ≈ 94 ms)** run to run.
- Clock sync was stable: **offset jitter 1–5 ms**. So the swing is **not** clock drift —
  it is real, measured BLE-delivery + audio-pipeline jitter (`bleOneway` + `audioGap`).
- 4 of 5 corrected values fell to **0.134–0.153 s**, below the human reaction floor
  (~0.15 s) and below the athlete's true reaction (≥0.20 s) ⇒ **systematic over-correction
  (~60–90 ms) on top of large residual noise.**

**Why it can't be fixed on the phone.** The correction measures *gate GO → engine
audio-start (phone clock)*. What's actually needed is *gate GO → sound at the athlete's
ear*. The gap between them — the speaker output path and its buffering jitter — is **not
observable from JS** (expo-audio does not expose `AVAudioSession.outputLatency`), and the
data shows that gap is large and variable enough to drive corrected results below the
human floor. Clock sync cannot touch it: the stimulus physically travels phone → air → ear
with an unknown, jittery delay. (This supersedes the ±25 ms estimate later in this doc,
which assumed a stable ~20 ± 15 ms acoustic term — in practice the per-run beep latency is
too jittery for the correction to be trustworthy.)

**What IS accurate (unaffected).** Only the **GO → Gate 1 reaction** is contaminated by the
phone cue. **Mode 1 total** and **Mode 2 Gate 1 → Gate 2** are pure gate-clock intervals
(no phone in the timing path) and remain accurate.

**Required fix — gate buzzer (gate-cued start).** Fire a buzzer on the gate at
`startTimeUs`; then `reaction = gate1_trigger − startTimeUs`, both in the **same** gate
`micros()` clock — no BLE, no phone audio, no acoustic unknown in the reaction path.
Residual ≈ sensor debounce + buzzer rise time, **≈ ±2–5 ms**. This is the only way to get
trustworthy reaction times.

**App behaviour as of this verdict.**
- Clean mode (default) shows **Gate 1 → Gate 2 (exact)** and a **raw total**; the reaction is
  shown **raw with a "+ beep latency (uncorrected)"** caveat — never the corrected number.
- The reaction correction is a **dev-mode-only** overlay; a corrected reaction below
  `REACTION_FLOOR_MS` (150 ms) is flagged **"unreliable / over-corrected"** and stored
  `status='suspect'` (excluded from session best/avg).
- The correction is never subtracted from totals or the session best (raw totals only).
- Raw gate values + the full per-run breakdown are still stored (`runs.raw_json` and the
  `[breakdown]` log) so nothing is lost and the verdict is re-checkable.

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

Default = **synced per-run correction**. For each Mode 2 run:

```
tAudioStart = tCallback - currentTime*1000     # engine playback start (interval-independent)
beepEngine  = tAudioStart - tGoPhone           # gate GO -> engine audio start (needs clock sync)
correction  = beepEngine + ACOUSTIC_OUTPUT_MS  # gate GO -> sound at the speaker
correctedReaction = max(0, raw_split1 - correction)   # flagged "suspect" if raw < correction
```

`ACOUSTIC_OUTPUT_MS` (20 ms) is the assumed gap between the player's playback
position advancing and sound leaving the speaker — iOS exposes this as
`AVAudioSession.outputLatency`, but **expo-audio does not surface it**, so it is the
main *unmeasurable* term (see below). Audio start is back-calculated from
`currentTime` so it's independent of the (10 ms) status interval; the audio
pipeline is primed (silent play at go-imminent) and `go.play()` runs with no
`await` on the GO event. Raw gate values are always stored; the full per-run
breakdown (`beepEngine`, `acousticMs`, `confMs`, `minRttMs`, `offsetSpreadMs`) is
saved in `runs.raw_json` so everything is re-derivable. Fixed-offset mode remains
as a fallback/comparison.

## Residual accuracy (±X)

After per-run subtraction, the *measured* components (BLE one-way, audio gap) are
removed — what remains is the **measurement error**, shown on the result as `±X ms`:

```
±X = sqrt( eClk^2 + eAcoustic^2 + eAudio^2 )
  eClk      = minRTT/2     clock-sync bound (conservative; the offset maps gate GO
                           into phone time, so its error biases every correction).
                           Set by the iOS connection interval — REDUCIBLE.
  eAcoustic = 15 ms        ± on the assumed 20 ms acoustic output latency.
                           UNMEASURABLE here (expo-audio hides outputLatency).
  eAudio    = 5 ms         residual audio-start noise after the currentTime back-calc.
```

Worked estimate on this hardware (beep 313 ms sd 61, BLE one-way 88 ms sd 43, audio
gap 225 ms sd 30, min RTT ≈ 40 ms): `eClk ≈ 20`, so **±X ≈ √(20² + 15² + 5²) ≈ ±25 ms**.

Honest reading of the terms:
- **Clock-sync (`eClk`, ≈ ±20 ms) currently dominates**, because we removed
  `updateConnParams` (it broke connecting), so iOS uses its default ~30 ms interval.
  A *deferred*, Apple-compliant connection-param request (15 ms) would roughly halve
  this to ≈ ±10 ms. This term is **reducible**.
- **Acoustic output (`eAcoustic`, ±15 ms) is the irreducible unmeasurable.** It is the
  gap between "playback position advanced" and "sound at the speaker," which no API
  surfaced here lets us measure per run. This is the term that **justifies the gate
  buzzer**: a buzzer fired at `startTimeUs` puts the stimulus *and* the clock on the
  gate, eliminating clock-sync, BLE, and acoustic latency from the reaction path
  entirely (residual then ≈ sensor debounce, ~±2 ms).

So: synced per-run correction takes the raw ~±61 ms beep jitter down to **≈ ±25 ms**,
and tightening the BLE interval would reach **≈ ±18 ms** — but the acoustic floor
(~±15 ms) cannot be crossed on a phone-cued start. The buzzer is the real fix.

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

- The audio-start timestamp tracks the player's playback **position**, not acoustic
  output; the engine→speaker gap (`AVAudioSession.outputLatency`) is not exposed by
  expo-audio, so it is assumed (20 ± 15 ms) — the dominant unmeasurable term.
- Clock-sync error (~minRTT/2) is set by the iOS connection interval, which the app
  can't read or force; it currently dominates ±X and is reducible by tightening the
  interval (deferred `updateConnParams`, Apple-compliant 15 ms).
- The only way to fully remove phone-beep latency from reaction timing is a
  **buzzer on the gate** firing at `startTimeUs` (gate-cued start): residual ≈ sensor
  debounce (~±2 ms). The clock-synced per-run correction (≈ ±25 ms here) is the best
  achievable while the cue stays on the phone.

## Other accuracy levers (tried / available)
- **`currentTime` back-calc** for audio start (done) — removes update-interval
  quantization.
- **Empirical clock-sync jitter** (`offsetSpreadMs`, done) — shows whether the sync
  samples agree; if small, the systematic asymmetry (≤ minRTT/2) is the bound.
- **Tighter BLE interval** (deferred `updateConnParams` 15 ms) — halves `eClk`.
- **Gate buzzer at `startTimeUs`** — removes clock-sync + BLE + acoustic entirely.
  The real fix.
