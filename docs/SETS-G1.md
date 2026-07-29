# g1 — Independent gate sets (channel-per-set)  ·  SPEC FOR ARGUMENT, NOT YET BUILT

> **Status: proposed.** Argue this line-by-line (like §12.1 standalone), then it gets built in
> `firmware/gate-g1/gate-g1.ino`. The frozen build `firmware/gate/gate.ino`
> (`gate-f2-FROZEN-2026-07-21`) is **never edited** and stays the validated single-set fallback.
> The contract delta (§2 below) is **proposed text** — `docs/BLE-CONTRACT.md` is not touched
> until this spec is approved.

**Requirement.** A few independent 2-gate sets must run in the same radio space without
cross-talk (election, time-sync, event pairing, standalone all currently bleed across sets on
ch1/broadcast). Right-sized: one-coach-at-a-time product, collisions are rare (demo day, own
gates during testing) — proportional effort, not a flagship subsystem.

**Decisions locked by Louis (2026-07-21):**
1. **Channel-per-set**, not a group-ID in the frame. Set 1→ch1, Set 2→ch6, Set 3→ch11. Cap 3.
2. **App-based set changing only** (closed loop via the relay). No no-phone button handshake.
3. **Reboot-to-apply**, not a live channel hop. Zero new code in the radio hot path.
4. **Live gate-count on the OLED**; standalone **refuses to arm** when >1 "other" gate is visible.
5. Out-of-the-box and after `RESTORE_DEFAULTS`: **Set 1 (ch1)** — factory pairs work with zero config.

---

## 1. Design: the channel IS the network

A set is defined by its Wi-Fi channel. A gate on ch6 physically never receives ch1 frames, so
election, TIME_SYNC, event pairing, standalone origin-keying, and the BLE relay are all scoped
per-set **with no logic changes** — the radio does the filtering below the code we validated.

- **Set → channel map (fixed in firmware):** `1→ch1, 2→ch6, 3→ch11`. These are the only three
  mutually non-overlapping 2.4 GHz channels, and all three are legal worldwide — which is *why*
  the ceiling is 3, not a style choice. We store the **set number** (1–3) in NVS, never a raw
  channel, so a corrupted value can only ever clamp to a legal channel.
- **Documented ceiling:** >3 simultaneous sets requires layering a logical group-ID on top of
  channels — that reopens the frozen frame (event `flags` byte, heartbeat widening to 8 bytes,
  a group byte on every frame type) and the app parser. Known future cost, **not built now**.
- **The `ESPNOW_CHANNEL` #define becomes a boot-time variable** (`channelForSet(params.setNumber)`)
  used at exactly the call sites that exist today: initial `esp_wifi_set_channel`, the broadcast
  peer's `.channel`, and the post-`setupBLE()` re-assert. Because the channel never changes at
  runtime (reboot-to-apply), there is **no possible runtime drift** between the radio channel and
  the registered peer — the simplicity payoff of decision 3.
- Election / TIME_SYNC / standalone / BLE GATT / `sdiff32` / RUN_HINT: **byte-identical code.**

## 2. Contract delta (proposed — applies to BLE-CONTRACT.md only after approval)

The frozen surfaces are untouched. Everything lands in space explicitly reserved at freeze:

**2a. `SET_PARAM` table (§8.1): wire `0x0009` from the reserved pool**

| `param_id` | Name | Unit | Default | Status | Notes / clamp |
|---|---|---|---|---|---|
| `0x0009` | `SET_NUMBER` | 1–3 | `1` | **wired (g1)** | radio set → channel `{1→ch1, 2→ch6, 3→ch11}`. **Always persisted** (the `persist` flag is ignored for this param — a non-persisted set number is meaningless, since the value only takes effect at the **next boot**). **Reboot-to-apply.** Clamp `1…3` — on write **and** on NVS load, per §8.1 rules. |

**2b. `STATUS_REPLY` caps byte (§9): define reserved bits 4–7**

```
[7] caps   bit0 has_display, bit1 has_buttons, bit2 buzzer_wired, bit3 time_synced,
           bits4-6 set_number (0 = firmware without sets, i.e. f2-FROZEN; 1-3 = ACTIVE set),
           bit7   reboot_pending (persisted SET_NUMBER differs from the active set)
```

f2 units already emit 0 in bits 4–7, which reads correctly as "no sets support" forever — a
compatible reserved-space extension, same philosophy as the reserved param ids.

**2c. `fw_ver` (§17): g1 reports `fw_ver = 3`.** `proto_ver` stays **2** — no frame format changes.

**Explicitly unchanged:** the 7-byte event frame (incl. `flags` still reserved-0), heartbeat
(stays 7 bytes — under group-ID it would have had to widen, since bytes 1–6 are all MAC),
TIME_SYNC payload, all command/reply layouts, GATT, legacy-reserved ranges.

## 3. NVS, boot, and the f2→g1 upgrade

- `Params` struct gains `setNumber` → **`PARAM_VER` 1→2**. An f2-written blob fails the g1
  size/CRC check and is discarded → full defaults (Set 1). **Consequence, stated honestly:
  reflashing f2→g1 silently discards any previously persisted param overrides** (debounce etc.).
  Rare and re-appliable via the app; documented, not hidden.
- Boot order (unchanged shape): `paramsLoad()` → clamp → B1-held check (restore) → radio init on
  `channelForSet(setNumber)`. The B1-boot restore therefore takes effect **the same boot** —
  it is the complete no-phone rescue: any gate, any state → Set 1/ch1.
- NVS garbage in `setNumber` → clamp to 1..3: worst case is a *wrong set*, visible on the OLED,
  never an illegal channel or a brick.

## 4. Set-change flow (app, closed loop)

Works with or without a full session bring-up — `target 0xFF` matches unassigned (id 0) gates.

1. App (connected to either gate) sends `SET_PARAM{target:0xFF, param:SET_NUMBER, value:2}`.
   Bridge persists + re-broadcasts; the remote gate self-matches and persists. Mid-run arrival is
   harmless — it only writes NVS; nothing changes until reboot.
2. App sends `GET_STATUS(0xFF)`. Each gate's `STATUS_REPLY` shows `reboot_pending=1` (and the
   still-active old set in bits 4–6). **A missing/pending-less reply = the write didn't land →
   the app retries step 1.** Command relay is single-shot (rebroadcast-N is events-only), so this
   ack-and-retry IS the reliability mechanism. Writing the already-active set → `pending=0`,
   correctly read as "nothing to do".
3. App instructs: **power-cycle both gates** (no remote-reboot command — new surface plus a
   mid-run footgun for zero real gain; set changes are a deliberate setup act).
4. After power-up both gates are on the new channel. App reconnects — **BLE is channel-agnostic**
   (its own 40-channel hopping; the ESP-NOW channel does not affect connectability) — and
   confirms `set_number=2, reboot_pending=0` on both.

**Failure/split recovery (all three exist):**
- *Coach cycles only one gate:* pair splits (ch6 vs ch1-with-pending). Both show `NO GATE` **plus
  their set number** (§5) — the mismatch is visible on the glass; cycling the second gate heals it.
- *Post-reboot split (missed write + premature cycle):* app connects to the stray **directly over
  BLE** (channel-agnostic) and re-issues `SET_PARAM` to the connected gate — no relay needed.
- *No phone at all:* hold B1 at boot → defaults → Set 1. Both gates restored → paired on ch1.

**No-phone set *changing*** (decision 2): confirmed **not trivial** — it would need its own
broadcast/ack/auto-revert handshake state machine, i.e. exactly the moving-parts reboot-to-apply
was chosen to avoid. Skipped; B1-boot-restore is the only no-phone path, and it only goes *to*
Set 1.

## 5. Stray-gate defense (decision 4)

Channel-per-set has no group byte, so a stray gate on the same channel is indistinguishable on
the wire. The defense is **counting**, and the count comes for free at the radio layer:

- **Per-MAC peer table** keyed on `esp_now_recv_info.src_addr` (the radio-level sender MAC on
  *every* inbound frame — no payload parsing, no frame change). 4 slots, LRU, expiry =
  `PEER_TIMEOUT_MS` (5 s). Replaces the single `peerLastHeardMs`. `otherCount` = live entries.
- **OLED:** set number on the boot splash, `NO GATE`, `SYNCING`, and `READY` screens (`S2`).
  `READY` also shows the live gate count; total ≠ 2 → warning glyph (`S2 3g ⚠`). A pending
  reboot shows `S1→2 REBOOT`. (Exact pixel layout is an implementation detail; the *requirement*
  is: set always visible, count visible on READY, mismatched-set pairs diagnosable from the glass
  because each gate names its set on the `NO GATE` screen.)
- **Arm refusal:** with `otherCount > 1`, B1-arm, B2-hold, **and RUN_HINT mirror-arm** are all
  refused (mirror included for consistency — a stray corrupts the mirrored display the same way).
  The count+⚠ on screen is the explanation; no extra error state.
- **Documented residuals (accepted as proportional):** (a) a stray appearing *mid-run* can still
  false-finish that one standalone run — the arm-time check closes the persistent-stray case
  (heartbeats land within the 5 s window well before a rep), the seconds-wide race stays open;
  (b) app-driven *data* is app-authority — for the app path this defense is advisory. **App-side
  note (unfrozen):** warn when discovery sees >2 MACs — that's two sets colliding on one set
  number, the one failure channels can't prevent.

## 6. Out-of-the-box (decision 5 — confirming Louis's read)

**Confirmed.** Virgin NVS → defaults → Set 1/ch1. `RESTORE_DEFAULTS` (app command or B1-at-boot)
→ Set 1. Two factory gates work as one set with zero configuration. Corollaries, stated plainly:
- Two *factory* pairs co-located both land on Set 1 and interfere **by design** — default is
  "simplest single-set case", not a unique network. The OLED count (`4g ⚠`) is how the second
  coach learns to move to Set 2.
- **Mixed fleet:** an f2-FROZEN gate is permanently ch1 → pairs with a g1 gate **on Set 1 only**.
  `SET_NUMBER` is an unknown-param no-op on f2 (by §8.1 rules), and f2's caps bits read
  "no sets" — both graceful.

## 7. Flash cost

Channel variable + param wiring + caps bits + per-MAC table + OLED set/count/pending lines +
arm-refusal: **~1–2 KB** code+strings. From 91%, comfortably inside the headroom we deliberately
refused to trim at freeze. (Verify the number on the first g1 compile and record it here.)

## 8. §18 re-validation — honest scope ("§18-g1")

Louis's assumption is correct and here is the precise *why*: **the code for election, time-sync,
and standalone is unchanged, but the RF envelope is new.** BLE+ESP-NOW coexistence was only ever
*observed* on ch1; the F1 modem-sleep failure taught us that this stack fails silently in
channel/coex corners we didn't test. So g1 earns its own freeze pass:

**Re-run (≈⅔ of §18):**
- Election settle + roles and TIME_SYNC convergence — **on ch6 and ch11**, not just ch1.
- Radio invariants (setSleep + now-variable channel pin, re-assert after BLE init) — all channels.
- App session (bring-up→arm→time→save) and both standalone modes — full pass on **ch6**, smoke on
  ch1 + ch11.
- Ball-drop agreement — on ch6, spot-check ch11.
- **20+ rep soak and long-idle soak — once, on ch6** (the moved coex envelope is the point).
- SET_PARAM/NVS suite — re-run including the PARAM_VER 1→2 migration (f2 blob → discarded →
  defaults), always-persist SET_NUMBER, RESTORE→Set 1, garbage-set→clamp.
- Reset soak on g1 (new boot-path code; same accepted power-class residuals as §18).

**New items:**
- **Isolation:** two sets running reps *simultaneously* side-by-side — zero cross events in the
  app log, correct standalone splits on both, elections independent.
- **Set-change flow:** happy path; deliberate missed-write (kill the remote before relay) →
  pending-ack catches it → retry; cycle-one-gate split → visible + heals; post-reboot stray
  rescued over direct BLE.
- **Stray defense:** third gate powered on-channel → count `3g ⚠`, B1/B2/mirror arms refused;
  power it off → arms restore within ~5 s.
- **Mixed f2+g1 pair on Set 1** works as a normal set.

**Not reopened:** frame parsing/format (unchanged), `sdiff32`/wrap *arithmetic* (channel-blind —
the ch6 soak still exercises the wrap window as RF), GATT, RUN_HINT semantics, v1 deletion.

**Bottom line: a full bench day like the f2 pass, not a smoke test.** g1 gets its own
`FROZEN` marker only after §18-g1 clears; `gate-f2-FROZEN-2026-07-21` remains flashable
throughout and is the rollback if g1 misbehaves in the field.

## 9. Deferred (documented, not built)

- **>3 sets:** group-ID layered on channels; reopens the frozen frame + app parser. Known cost.
- **No-phone set changing:** needs its own handshake machinery; B1-boot→Set 1 is the only
  no-phone path.
- **Multi-gate chains (>2 beams per run):** split confirmed — *app-driven chains are app-only*
  (raw `gate_id`-tagged events + N-gate `ASSIGN_IDS` already suffice; works on f2 today).
  *Standalone* chains need firmware rework (origin-keying assumes exactly one "other"; needs
  id-ordered sequencing). Note the coupling: §5's ">1 other → refuse arm" hardcodes the 2-gate
  assumption one level deeper — a future chains feature relaxes that check (app-driven chains
  are unaffected; they don't use the standalone consumer).
