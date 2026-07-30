# g1 — Independent gate sets (channel-per-set)

> **Status: at `gate-g1-a2 (membership filter)` in `firmware/gate-g1/gate-g1.ino`.**
> a1 passed the two-set DATA isolation test on hardware (2026-07-29) but exposed close-range
> cross-channel leakage poisoning the peer count and — latently — the election (§5a); a2 adds
> the set-tagged-heartbeat membership filter (§5b, approved by Louis). §8's §18-g1 pass is
> pending and non-negotiable (full bench day on ch6, incl. the named election-poisoning check).
> The frozen build `firmware/gate/gate.ino` (`gate-f2-FROZEN-2026-07-21`) is untouched and
> stays the validated single-set fallback. The §2 contract delta is applied to BLE-CONTRACT.md.

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

**2c. `HEARTBEAT` gains the set tag (a2, contract §10):** g1 heartbeats are 8 bytes,
`[7] = set_number`; a 7-byte heartbeat (f2) reads as implicit Set 1. HEARTBEAT is a link frame —
payload firmware-internal by contract, same rule as TIME_SYNC — so this is NOT a frozen-frame
change. It exists because bench testing proved the channel is a filter, not a wall (§5a).

**Explicitly unchanged:** the **7-byte event frame — byte-identical, no group byte, ever**
(the deliberate line between this and the rejected group-ID design), TIME_SYNC payload,
all command/reply layouts, GATT, legacy-reserved ranges.

## 3. NVS, boot, and the f2→g1 upgrade  *(amended per Louis 2026-07-21: migrate, don't discard)*

- `Params` gains `setNumber` (`u8`) → **`PARAM_VER` 1→2**. The layout cooperates: `setNumber`
  lands in what was zero-padding after `rebroadcastN` (`paramsSave` memsets the blob, so v1 pads
  are deterministically 0), every shared field keeps its offset, and the blob stays 24 bytes —
  guarded by `static_assert(sizeof(Params)==16 && sizeof(PersistBlob)==24)` so the compiler
  enforces the assumption the migration relies on.
- **Migration (one-shot):** `paramsLoad` accepts ver 1 *or* 2 (same magic, same CRC algorithm —
  a v1 blob's CRC verifies as-stored). A ver-1 blob keeps all shared params (debounce, threshold,
  standalone timeout, rebroadcast-N), sets `setNumber = 1` explicitly, clamps, then **re-saves as
  ver 2** so the upgrade happens exactly once. Serial: `[param] migrated f2 (v1) blob`.
  **Flashing tuned f2 units → g1 preserves their persisted params automatically; nothing to
  re-apply, no phantom behavior change.** Unknown future versions (>2) still discard → defaults.
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

## 5. Stray-gate defense (decision 4) — REVISED a2: membership, not raw RX

### 5a. Why revised — the a1 bench finding (2026-07-29)

The a1 two-set isolation test passed for **data** but exposed the premise flaw: at bench range
(radios inches apart) the channel is a **filter (~25–40 dB), not a wall** — the receiver
intermittently demodulates FCS-valid frames from the other set's channel. Everything fed from
raw RX was contaminated: (1) the peer count fluctuated 2–4 → stray-refusal locked out the
standalone buttons on phantom peers; (2) **election poisoning (the serious one):** `noteMac`
consumed leaked foreign heartbeats — the a1 data pass held only because the MAC ordering was
favorable; a foreign set holding the lowest MAC would silently demote a set's true master and
kill its time-sync; (3) leaked foreign `BEAM_BREAK`s could false-finish a standalone run
(origin-keyed = any "received" beam); (4) leaked `ASSIGN_IDS` could re-id the other set;
(5) the bridge relayed foreign heartbeats to the app ("2/4 connected"). Rejected fixes: RSSI
(cannot separate near-foreign from far-partner — no threshold works for both), advisory-only
count (the count was *honest* — audible foreign gates genuinely threaten standalone data),
group-ID-in-every-frame (reopens the frozen event frame; rejected at spec time and stays
rejected). At field separation the leakage largely vanishes, but demo day is the close-range case.

### 5b. The a2 design: set-tagged heartbeats + sender-MAC membership filter

- **Heartbeats carry the set** (`[7]`, §2c). Receivers build a **membership table**:
  MAC → `{set, lastHeardMs}`. The **frozen event frame is untouched** — membership is learned
  from the one unfrozen link frame and applied to everything else **by radio-level
  `src_addr`** (already captured per frame; no payload parsing).
- **Front-door rule:** heartbeats are always processed (they are the classifier; foreign ones
  classify-and-stop — no election `noteMac`, no relay, no count). Every other frame is
  **dropped unless its sender is a classified same-set member**. This sits before the
  standalone consumer, the election, the BLE relay, and the count — all five contamination
  paths above close at once.
- **Two clocks (deliberate — do not merge them):** *liveness* (count / NO_GATE / arm-refusal)
  keeps the 5 s window; *classification* (member vs foreign) is **sticky for the whole boot** —
  a set cannot change without a reboot (reboot-to-apply), and a rebooted gate re-heartbeats
  within ~1 s, so silence carries no classification information. A partner silent 6 s drops
  from the *count* but its next frame still passes the *filter*; it can never be re-treated as
  foreign. Re-classification happens only via a new heartbeat declaring a different set.
- **Unknown MACs** (no heartbeat heard yet this boot) are **dropped**: accepting them would
  defeat the filter, and the only exposure is the few seconds after our own boot — during which
  the consumer is still in `NO_GATE`/`SYNCING` (READY requires a live classified member), so
  nothing real is lost. Unknown-sender frames are not tabled; only heartbeats insert entries.
- **Table:** 6 slots (2 gates + strays), LRU-evict preferring stale-foreign, then foreign,
  never a live same-set member.
- **Mixed-era caveat (honest):** the filter protects the gate running it. f2/a1 gates near a
  foreign set have no filter of their own; full close-range protection = all co-located gates
  on ≥ a2.
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

**New items (a2 pass conditions per Louis, 2026-07-29):**
- **Isolation re-run (bench range):** two sets running reps simultaneously — zero cross events
  in the app log, correct standalone splits on both, and **all four OLEDs sit at `2g` steady,
  not fluctuating**.
- **Election-poisoning check (by name):** with both sets powered at bench range, each set
  elects **its own** master, and **neither set's gates ever print the other set's MAC as the
  lowest-MAC target in their `[v2] election ->` serial line**. This is the direct regression
  test for the a1 finding that the data pass was MAC-ordering luck.
- **Same-set stray:** a third gate deliberately configured to the SAME set → OLEDs show `3g!`,
  B1/B2/mirror arms refused; power it off → arms restore within ~5 s.
- **Membership stickiness:** silence a partner >5 s mid-session (block its beam/heartbeat path,
  not power) — count drops, but on resume its first frame is accepted (no foreign
  misclassification, no dropped first event).
- **Set-change flow:** happy path; deliberate missed-write (kill the remote before relay) →
  pending-ack catches it → retry; cycle-one-gate split → visible + heals; post-reboot stray
  rescued over direct BLE.
- **Mixed f2+g1 pair on Set 1** works as a normal set (a2: the f2 gate's 7-byte heartbeats
  classify as implicit Set 1 — verify the a2 gate counts and pairs with it normally).

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
