# EqualSplit BLE Contract v1

The wire contract between the **phone app** (BLE central) and **Gate 1 / start gate**
(BLE peripheral). Gate 2 (finish) is **not** part of this contract — it only speaks
ESP-NOW to Gate 1. This document is the single source of truth shared by firmware and app.

> Protocol version: **1** (exposed in the Status characteristic so both sides can detect a mismatch).

---

## 1. Topology

```
  Phone (BLE central)  ──BLE GATT──▶  GATE 1 (start, hub, timekeeper)  ──ESP-NOW──▶  GATE 2 (finish)
        observe + arm                  owns micros() clock,                          measures deltaUs
        + store results                computes authoritative time
```

Gate 1 is the only device the phone connects to. It already owns the clock and computes
the authoritative result in `processResult()`; BLE only **carries** that number. The phone
re-times nothing.

---

## 2. Conventions

- **Endianness:** little-endian for all multi-byte integers (ESP32 and ARM phones are both LE).
- **Time unit on the wire: `uint32` milliseconds.** Locked. This matches `RunRecord{totalMs,
  split1Ms, split2Ms}` and the OLED's `%.3f`, so the app and the gate display can never disagree.
- **Rounding happens at the source.** The gate rounds each timing value from µs to ms using
  **round-half-up** — `ms = (us + 500) / 1000` — the *same* expression already used in
  `processResult()`, applied **before** the value is written into any BLE payload
  (`FINISH`, `SPLIT`, `LastResult`). Never send raw µs in a result field. (`t0_us` in
  `GO`/`START` is the lone exception: it is a raw diagnostic timestamp, not a result.)
- All notifications fit inside the default 23-byte ATT MTU (≤20-byte payload); no MTU
  negotiation is required.

---

## 3. Services & characteristics

Base UUID: `7E5D00xx-9A1B-4C2D-8E3F-1A2B3C4D5E6F` — vary only the first group.

| Characteristic | UUID | Properties | Purpose |
|---|---|---|---|
| **Timing Service** | `7E5D0001-9A1B-4C2D-8E3F-1A2B3C4D5E6F` | — | container, advertised |
| Command    | `7E5D0002-9A1B-4C2D-8E3F-1A2B3C4D5E6F` | Write w/ response | phone → gate commands |
| Event      | `7E5D0003-9A1B-4C2D-8E3F-1A2B3C4D5E6F` | Notify | gate → phone live event stream |
| LastResult | `7E5D0004-9A1B-4C2D-8E3F-1A2B3C4D5E6F` | Read + Notify | latest authoritative result, re-readable after reconnect |
| Status     | `7E5D0005-9A1B-4C2D-8E3F-1A2B3C4D5E6F` | Read + Notify | gate state, mode, finish-link health, versions |
| Device Info *(optional)* | `0x180A` (standard) | Read | manufacturer / model / firmware rev |

**Advertising:** device name `EqualSplit-G1`, advertising the Timing Service UUID. The app
scans by **service UUID**, not by name.

---

## 4. Command characteristic (phone → gate)

Fixed 4 bytes, written with response:

```
byte0: opcode
byte1: arg0
byte2: arg1
byte3: arg2   (reserved unless noted)
```

| Opcode | Name | Args | Maps to today |
|---|---|---|---|
| `0x01` | `ARM_MODE1`      | — | press Button 1 from idle |
| `0x02` | `ARM_MODE2`      | — | press Button 2 (enters M2 armed; physical hold/release still works) |
| `0x03` | `START_SEQUENCE`| arg0=minDelay, arg1=maxDelay (100 ms units; `0,0` = gate default, e.g. 2–5 s) | *(new)* phone-initiated random "marks / set / GO" |
| `0x04` | `RESET`         | — | cancel a run / dismiss a result → idle |
| `0x05` | `GO_NOW` *(optional)* | — | immediate phone GO, no random delay |
| `0x06` | `PING` *(optional)*   | — | gate echoes its current `micros()` into Status (latency probe) |

Commands drive the **same** state transitions as the hardware buttons and coexist with them —
neither disables the other.

---

## 5. Event characteristic (gate → phone, Notify)

```
byte0: type
byte1: seq          (rolling 0..255; app detects a gap = dropped notification)
byte2..: payload
```

| Type | Name | Payload | Fired when |
|---|---|---|---|
| `0x10` | `STATE`     | `state:u8, mode:u8` | every `currentMode` change |
| `0x11` | `COUNTDOWN` | `phase:u8` (1=marks, 2=set, 3=go-imminent) | during a phone random sequence (UI/audio only) |
| `0x12` | `GO`        | `mode:u8, t0_us:u32` | Mode 2 clock start (`startTimeUs` set — button **or** phone path) |
| `0x13` | `START`     | `mode:u8, t0_us:u32` | Mode 1 clock start (Gate-1 beam break) |
| `0x14` | `SPLIT`     | `mode:u8, index:u8, split_ms:u32` | Mode 2 Gate-1 crossing (index=1 → `firstSplitUs`) |
| `0x15` | `FINISH`    | `mode:u8, total_ms:u32, split1_ms:u32, split2_ms:u32, flags:u8` | end of `processResult()` — **authoritative** |
| `0x1E` | `NOTICE`    | `code:u8` | non-fatal events (see §8) |

`t0_us` is the gate's raw `micros()` at the start instant — a diagnostic for optional
clock back-dating only; it is **not** a result and is not rounded.

`FINISH` byte layout (15 bytes incl. header):

```
[0]=0x15  [1]=seq  [2]=mode
[3..6]=total_ms (u32 LE)
[7..10]=split1_ms (u32 LE)
[11..14]=split2_ms (u32 LE)
[15]=flags        <-- (payload is 13 bytes; total frame 16 with header)
```

`flags` bits: `bit0`=valid result, `bit1`=false/early start, `bit2`=finish-link was recovered.
For Mode 1, `split1_ms = split2_ms = 0` and `total_ms = g1ToG2`.

---

## 6. State enum

Mirrors firmware `SystemMode`:

| Value | Name | Firmware state |
|---|---|---|
| 0 | `IDLE`         | `MODE_IDLE` |
| 1 | `RESULT`       | `MODE_SHOWING_RESULT` |
| 2 | `M1_ARMED`     | `MODE_1_ACTIVATED` |
| 3 | `M1_RUNNING`   | `MODE_1_WAITING_GATE2` |
| 4 | `M2_ARMED`     | `MODE_2_ACTIVATED` |
| 5 | `M2_TO_GATE1`  | `MODE_2_WAITING_GATE1` |
| 6 | `M2_TO_GATE2`  | `MODE_2_WAITING_GATE2` |
| 7 | `M2_COUNTDOWN` | *(new — phone random sequence before GO)* |

---

## 7. LastResult & Status (robustness in the field)

**LastResult** (Read + Notify) — the gate keeps this current so a dropped BLE link never
loses a result. The app reads it on every (re)connect.

```
mode:u8, total_ms:u32, split1_ms:u32, split2_ms:u32, flags:u8, run_index:u8   (16 bytes)
```

**Status** (Read + Notify) — the app reads this on connect to resync.

```
proto_ver:u8, state:u8, mode:u8, run_count:u8, finish_link_ok:u8, gate_micros:u32   (9 bytes)
```

`finish_link_ok` is derived from the last `esp_now_send` callback status (a free
"is Gate 2 reachable?" indicator). `gate_micros` answers an optional `PING`.

---

## 8. NOTICE codes (`0x1E`)

| Code | Meaning |
|---|---|
| 1 | mode timeout — gate auto-reset to idle |
| 2 | finish-gate send failed (ESP-NOW) |
| 3 | double-trigger ignored (debounce) |
| 4 | command rejected (invalid in current state) |

---

## 9. Mode sequences

**Mode 1** (gate-to-gate; clock starts at the Gate-1 crossing):

```
ARM_MODE1 → STATE(M1_ARMED) → [break Gate 1] → START(t0)
          → [break Gate 2] → FINISH(total=g1ToG2, split1=0, split2=0)
```

**Mode 2** (reaction start + split; clock starts at GO):

```
ARM_MODE2 → STATE(M2_ARMED)
   ├─ button path:  [hold/release Btn 2] ───────────────────┐
   └─ phone path:   START_SEQUENCE → COUNTDOWN(1,2,3) ───────┤→ GO(t0)
   → [break Gate 1] → SPLIT(index=1, split1 = firstSplitUs)
   → [break Gate 2] → FINISH(total=split1+split2, split1=GO→G1, split2=G1→G2)
```

The gate stamps `startTimeUs = micros()` locally in **both** Mode 2 paths, so the phone is
never in the timing-critical path.

---

## 10. Firmware implementation notes

1. **BLE + ESP-NOW coexistence.** The WROOM-32 shares one 2.4 GHz radio between WiFi
   (ESP-NOW) and BLE. Validate first that enabling BLE does not perturb the round-trip
   correction in `processResult()` — run a normal Mode-1 timing with BLE active and compare.
   Prefer **NimBLE-Arduino** (much lower RAM than the stock BLE stack).
2. **Round at the source** (§2): populate `FINISH`/`SPLIT`/`LastResult` from the already
   `(us+500)/1000`-rounded ms values, exactly as the OLED does.
3. **Emit at existing transition points:** `STATE` on every `currentMode` change; `START`
   in `handleGate1Trigger` (mode 1); `GO` at the Mode-2 GO instant (both paths); `SPLIT`
   in `handleGate1Trigger` (mode 2, carrying `firstSplitUs`); `FINISH` at the end of
   `processResult`.
4. **Non-blocking random countdown.** The current Mode 2 uses blocking `while` loops with
   `yield()`. The phone-initiated `START_SEQUENCE` path should be non-blocking so BLE stays
   responsive: emit `COUNTDOWN` phases, then set `startTimeUs = micros()` at GO.
5. Keep `LastResult` and `Status` characteristic values updated on every change.

---

## 11. Versioning

`proto_ver` (Status, byte 0) = **1**. Bump on any breaking layout change. The app should warn
and refuse to interpret results if it sees an unknown `proto_ver`.
