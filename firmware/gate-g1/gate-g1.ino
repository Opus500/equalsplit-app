// ============================================================================
// EqualSplit — SYMMETRIC WRITE-ONCE GATE (v2 only)  — see docs/BLE-CONTRACT.md
// ----------------------------------------------------------------------------
// One binary, both gates. It:
//   * timestamps raw beam edges in a SHARED gate-network clock and BROADCASTS
//     them (every gate broadcasts its OWN events, spaced N-times for loss),
//   * relays every gate's events up to the app over BLE when a phone connects
//     (any gate can be the bridge — the one the phone happens to connect to),
//   * runs a lowest-MAC time-master election (symmetric TIME_SYNC),
//   * consumes the SAME event stream itself to time a run with NO phone
//     (standalone consumer, §12.1 — display gates only),
//   * accepts the frozen v2 command set incl. SET_PARAM (§8.1) with NVS persist.
// The app owns all meaning (modes, splits, timeouts). There is no v1 here.
//
// BUMP FW_BUILD every change. __DATE__/__TIME__ auto-update only on a REAL
// recompile, so a stale build cache is caught by an old compile timestamp.
#define FW_BUILD "gate-g1-a2 (membership filter)"
// ============================================================================

#include <Wire.h>
#include <U8g2lib.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_mac.h>       // esp_efuse_mac_get_default() — factory MAC from eFuse
#include <esp_wifi.h>      // esp_wifi_set_channel() — pin the ESP-NOW channel
#include <Preferences.h>   // NVS wrapper for SET_PARAM persistence (§8.1)
#include <NimBLEDevice.h>  // "NimBLE-Arduino"

// ESP-NOW peers must share ONE WiFi channel; a broadcast only reaches same-channel
// gates. Also disable modem-sleep: passive broadcast RX needs the radio awake
// (contract §15 — load-bearing, F1 proved omitting it silently kills the network).
//
// g1: the channel IS the set (docs/SETS-G1.md). Derived from params.setNumber at
// BOOT only (reboot-to-apply, contract §8.1 SET_NUMBER): Set 1→ch1, 2→ch6, 3→ch11 —
// the three mutually non-overlapping 2.4 GHz channels, legal worldwide (why the cap
// is 3). No runtime channel change ever: channel and peer registration cannot drift.
uint8_t espnowChannel   = 1;   // set in setup() from params.setNumber
uint8_t bootedSetNumber = 1;   // the set we actually came up on (STATUS caps bits 4-6)
static uint8_t setToChannel(uint8_t s) { return s == 2 ? 6 : (s == 3 ? 11 : 1); }

// ===================== v2 wire constants (FROZEN, §5) =======================
#define V2_FW_VER 3   // g1 (channel-per-set). proto_ver stays 2 — no frame format changed.
// Events 0x01-0x0F
#define V2_BEAM_BREAK    0x01
#define V2_BEAM_CLEAR    0x02
#define V2_BUZZER_FIRED  0x03
#define V2_BUTTON_PRESS  0x04
// Link / discovery 0x20-0x2F
#define V2_HEARTBEAT     0x20
#define V2_TIME_SYNC     0x21
// Commands 0x30-0x3F
#define V2_ASSIGN_IDS    0x30
#define V2_SET_THRESHOLD 0x31
#define V2_BUZZER_FIRE   0x32
#define V2_CLEAR_QUEUE   0x33
#define V2_PING          0x34
#define V2_GET_STATUS    0x35
#define V2_SET_PARAM     0x36
#define V2_RUN_HINT      0x37    // display-only mirror arm/disarm hint (contract §8.2)
// Replies 0x40-0x4F
#define V2_PING_REPLY    0x40
#define V2_STATUS_REPLY  0x41
// TIME_SYNC subtypes — firmware-internal payload (type 0x21 frozen, payload not)
#define TS_PING 0x01
#define TS_PONG 0x02

#define GATE_ID_ALL 0xFF

// SET_PARAM param_ids (§8.1). Only the "wired" ones act; reserved ids are no-ops
// in THIS frozen firmware (the NUMBER is reserved so a future firmware could use it).
#define PID_RESTORE_DEFAULTS   0x0000
#define PID_BEAM_DEBOUNCE_US   0x0001
#define PID_THRESHOLD_CM       0x0003
#define PID_STANDALONE_TMO_MS  0x0004
#define PID_EVENT_REBROADCAST  0x0008
#define PID_SET_NUMBER         0x0009   // g1: radio set 1-3 → ch1/6/11; reboot-to-apply, always-persist

// ===================== GATT (end-state, §3) =================================
#define UUID_SERVICE  "7E5D0001-9A1B-4C2D-8E3F-1A2B3C4D5E6F"
#define UUID_COMMAND  "7E5D0002-9A1B-4C2D-8E3F-1A2B3C4D5E6F"
#define UUID_EVENT    "7E5D0003-9A1B-4C2D-8E3F-1A2B3C4D5E6F"
// (0004 LastResult / 0005 Status are v1-only and intentionally gone — the app
//  uses PING_REPLY 0x40 for the clock offset and STATUS_REPLY 0x41 for status.)

// ===================== hardware pins ========================================
#define LUNA_RX     16
#define LUNA_TX     17
#define BUTTON1_PIN 15            // standalone arm / cancel / re-arm
#define BUTTON2_PIN 4             // reserved (still emits BUTTON_PRESS)
#define BUZZER_PIN  25            // declared now, wired at PCB respin (§15)
#define OLED_I2C_ADDR 0x3C

U8G2_SH1106_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);
bool has_display = false;         // feature-detected in setup (§6)

// ===================== BLE state ============================================
NimBLECharacteristic* chEvent = nullptr;
volatile bool bleConnected = false;

// Deferred conn-param request (tight 15ms interval shrinks clock-sync error).
// Requesting inside onConnect broke the iOS link, so we DEFER and fire once from
// loop() after the link settles. updateConnParams only requests — a decline just
// keeps current params (no drop), so it is safe to fail.
volatile bool connParamPending = false;
uint16_t pendingConnHandle = 0;
unsigned long connParamDueMs = 0;
const unsigned long CONN_PARAM_DELAY_MS = 3000;

// ===================== identity & election =================================
uint8_t bcastMAC[] = {0xFF,0xFF,0xFF,0xFF,0xFF,0xFF};
uint8_t myMac[6]   = {0};
uint8_t v2GateId   = 0;           // 0 = unassigned until ASSIGN_IDS

// Lowest-MAC time-master election. MASTER (offset 0, always synced, answers
// TS_PING) if our MAC is the lowest we've heard, else FOLLOWER (pings the master,
// applies TS_PONG). Boot = master until a lower MAC's heartbeat demotes us.
volatile int32_t clkOffset = 0;
volatile bool    timeSynced = true;
bool     isMaster = true;
uint8_t  lowestMac[6] = {0};
uint32_t tsMinRtt = 0xFFFFFFFFUL;
uint32_t tsSeq = 0;
unsigned long lastTsPingMs = 0, lastTsResetMs = 0;

// g1-a2: membership + liveness (SETS-G1 §5b). The a1 bench test proved the
// channel is a FILTER (~25-40dB), not a wall — at close range the radio delivers
// FCS-valid frames from the other set's channel, which poisoned the count, the
// election (noteMac ate leaked heartbeats), and threatened standalone pairing.
// Fix: heartbeats carry the sender's set ([7], contract §10); receivers classify
// each MAC and drop every non-heartbeat frame from a non-member sender.
// TWO CLOCKS, deliberately separate: liveness (count/NO_GATE/refusal) uses the
// 5s window; classification (member vs foreign) is STICKY for the whole boot —
// sets can't change without a reboot (reboot-to-apply), so silence carries no
// classification information. A 6s-silent partner drops from the COUNT but its
// next frame still passes the FILTER; it can never be misread as foreign.
#define PEER_SLOTS 6                       // partner + strays + foreign-set gates
uint8_t       peerMacs[PEER_SLOTS][6];
uint8_t       peerSet[PEER_SLOTS];         // classified set (sticky; from heartbeats)
unsigned long peerLastMs[PEER_SLOTS];      // liveness stamp; 0 = empty slot
const unsigned long PEER_TIMEOUT_MS = 5000;

// ===================== runtime params + NVS persistence (§8.1) =============
struct Params {
  uint32_t beamDebounceUs;      // 0x0001
  uint16_t thresholdCm;         // 0x0003 (also settable via SET_THRESHOLD 0x31)
  uint32_t standaloneTimeoutMs; // 0x0004
  uint8_t  rebroadcastN;        // 0x0008 (total sends per event, incl. the first)
  uint8_t  setNumber;           // 0x0009 (g1) — occupies what was v1 zero-padding, so
                                //   every shared field keeps its offset (migration, §3)
};
Params params;
Preferences prefs;
#define PARAM_MAGIC 0x45510001UL      // 'EQ' + rev
#define PARAM_VER   2                 // 1 = f2-FROZEN blob (migrated on load, SETS-G1 §3)
struct PersistBlob { uint32_t magic; uint16_t ver; uint16_t crc; Params p; };
// The v1→v2 in-place migration relies on this exact layout; if either assert ever
// fires, the migration in paramsLoad() must be rewritten, not the assert deleted.
static_assert(sizeof(Params) == 16, "Params layout must match the f2 (v1) blob");
static_assert(sizeof(PersistBlob) == 24, "PersistBlob layout must match the f2 (v1) blob");

// ===================== beam / button / buzzer emit state ===================
bool v2LastBeam = false;
unsigned long v2DebounceUs = 0;
bool v2B1Last = false, v2B2Last = false;
unsigned long v2B1Deb = 0, v2B2Deb = 0;
bool buzzerOn = false;
unsigned long buzzerOffMs = 0;
unsigned long lastHeartbeatMs = 0;

// ===================== command handoff (NimBLE task -> loop) ===============
volatile bool v2CmdPending = false;
uint8_t v2CmdBuf[32];
volatile uint8_t v2CmdLen = 0;

// ===================== inbound ESP-NOW staging =============================
#define V2_RX_SLOTS 8
uint8_t v2Rx[V2_RX_SLOTS][32];
uint8_t v2RxLen[V2_RX_SLOTS];
uint8_t v2RxMac[V2_RX_SLOTS][6];           // g1: radio src_addr, for peer tracking
volatile uint8_t v2RxHead = 0, v2RxTail = 0;

// ===================== BLE relay ring (drains to app) ======================
#define V2_QUEUE_LEN 64
uint8_t evQ[V2_QUEUE_LEN][7];
volatile uint16_t evQHead = 0, evQTail = 0;

// ===================== received-event dedup (N-rebroadcast + relay) ========
#define SEEN_SLOTS 32
uint8_t seenKey[SEEN_SLOTS][6];   // type, gate_id, micros[4]
uint8_t seenIdx = 0;

// ===================== spaced event retransmit (§12.1.2) ===================
struct Reb { uint8_t f[7]; unsigned long dueMs; uint8_t left; bool active; };
#define REB_SLOTS 8
Reb rebRing[REB_SLOTS];
const unsigned long REB_SPACING_MS = 7;   // ~5-10ms so copies don't die together

// ===================== standalone consumer (§12.1 + Mode 1/2 + mirror) =====
enum SaState {
  SA_NO_GATE, SA_SYNCING, SA_READY,
  SA_ARMED,          // Mode 1 armed (B1)
  SA_RUNNING,        // Mode 1 running (also used for app-mirror runs)
  SA_M2_HOLD,        // Mode 2: B2 held, waiting for release-to-GO
  SA_M2_RUN1,        // Mode 2: GO fired, waiting for the first gate
  SA_M2_RUN2,        // Mode 2: first gate hit, waiting for the second
  SA_RESULT,         // result held (saIsM2 selects the layout)
  SA_TIMEOUT
};
SaState saState = SA_SYNCING;
bool     saMirror = false;        // true = app-driven run mirrored for display only
bool     saIsM2 = false;          // result layout: two-split (Mode 2) vs one (Mode 1)
bool     saStartLocal = false;    // origin of the start / first-gate edge
uint32_t saGoUs = 0;              // Mode 2 GO instant (button release), shared clock
uint32_t saStartUs = 0;           // Mode 1 start / Mode 2 first-gate instant
uint32_t saSplitMs = 0;           // Mode 1 total (also Mode 2 total)
uint32_t saSplit1Ms = 0, saSplit2Ms = 0;  // Mode 2 splits
unsigned long saTimeoutAtMs = 0;  // run give-up wall time
unsigned long saShownMs = 0;      // transient RESULT/TIMEOUT display start
unsigned long saBtnLockMs = 0;    // B1 post-action lockout (restores v1's 500ms feel)
unsigned long v2B2PressMs = 0;    // when B2 was pressed (for the Mode-2 hold detect)
unsigned long lastDisplayUpdate = 0;
char lastRender[28] = "";
const unsigned long SA_BTN_LOCK_MS = 500;          // v1 idle-lockout value
const unsigned long SA_M2_HOLD_MIN_MS = 300;       // min B2 hold before "release to start"
const unsigned long SA_RESULT_AUTOCLEAR_MS = 4000; // mirror result auto-return

// on-device recent runs (no DB without a phone) — v1's idle history
struct RunRec { bool isM2; uint32_t totalMs; uint32_t s1Ms; uint32_t s2Ms; };
#define RECENT_MAX 10
RunRec recent[RECENT_MAX];
uint16_t recentCount = 0;   // total pushed; display shows the last few, newest first

// ===================== forward declarations ================================
uint32_t rd32(const uint8_t* p);
void putU32(uint8_t* b, uint32_t v);
int32_t  sdiff32(uint32_t a, uint32_t b);
uint32_t sharedMicros();
void notifyEvent(const uint8_t* payload, size_t plen);
uint16_t crc16(const uint8_t* d, size_t n);
uint32_t clampU32(uint32_t v, uint32_t lo, uint32_t hi);
void paramsSetDefaults();
void clampParams();
void paramsLoad();
void paramsSave();
void paramsRestoreDefaults();
void applyParam(uint16_t pid, uint32_t val);
bool readLuna(int16_t &dist);
void setLunaFrameRate(uint8_t fps);
void v2Enqueue7(const uint8_t* f);
void v2EmitLocalEvent(uint8_t type, uint32_t sharedUs, uint8_t flags);
void v2ServiceQueue();
void rebSchedule(const uint8_t* f, uint8_t copies);
void rebService(unsigned long now);
void v2BeamDetect(int16_t dist, unsigned long nowUs);
void v2ServiceButtons(unsigned long nowMs);
void v2FireBuzzer(uint16_t durMs);
void v2ServiceBuzzer(unsigned long nowMs);
void v2ServiceHeartbeat(unsigned long nowMs);
void v2SendPingReply(uint32_t appMicros);
void v2SendStatusSelf();
void v2SendPong(const uint8_t* pingFrame);
void v2ApplyPong(const uint8_t* f);
void v2ServiceTimeSync(unsigned long nowMs);
void updateElection();
void noteMac(const uint8_t* mac);
bool v2SeenEvent(const uint8_t* f);
uint8_t v2QueueDepth();
void v2Rebroadcast(const uint8_t* f, uint8_t len);
void v2DoAssignIds(const uint8_t* f, uint8_t len);
void v2DoSetParam(const uint8_t* f, uint8_t len);
void v2ExecCommand(const uint8_t* f, uint8_t len, bool fromBle);
void v2HandleCommand();
void v2HandleFrame(const uint8_t* f, uint8_t len);
void v2StageInbound(const uint8_t* d, int len, const uint8_t* srcMac);
void v2ProcessInbound();
int findPeer(const uint8_t* mac);
void notePeerHeartbeat(const uint8_t* mac, uint8_t set, unsigned long now);
int8_t peerVerdict(const uint8_t* mac, unsigned long now);
uint8_t otherGateCount(unsigned long now);
void saGo(SaState s);
void saOnB1(unsigned long nowMs);
void saOnB2Release();
void saOnRunHint(bool armed);
void pushRecentRun(bool isM2, uint32_t totalMs, uint32_t s1, uint32_t s2);
void saOnEvent(uint8_t type, bool local, uint32_t us);
void saService(unsigned long now);
void saRender();
bool detectDisplay();
void setupBLE();
void serviceConnParam();

// ===================== small utilities =====================================
uint32_t rd32(const uint8_t* p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
void putU32(uint8_t* b, uint32_t v) {
  b[0] = v & 0xFF; b[1] = (v >> 8) & 0xFF; b[2] = (v >> 16) & 0xFF; b[3] = (v >> 24) & 0xFF;
}
// Wrap-safe signed modular subtraction (§11.1). Correct for any true interval
// < 2^31 us (~35.8 min), even across the ~71.6-min micros wrap.
int32_t sdiff32(uint32_t a, uint32_t b) { return (int32_t)(a - b); }
// Local micros mapped into the shared gate-network clock. Master: clkOffset 0.
uint32_t sharedMicros() { return (uint32_t)micros() + (uint32_t)clkOffset; }
uint32_t clampU32(uint32_t v, uint32_t lo, uint32_t hi) { return v < lo ? lo : (v > hi ? hi : v); }

uint16_t crc16(const uint8_t* d, size_t n) {
  uint16_t crc = 0xFFFF;
  for (size_t i = 0; i < n; i++) {
    crc ^= (uint16_t)d[i] << 8;
    for (int b = 0; b < 8; b++) crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021) : (uint16_t)(crc << 1);
  }
  return crc;
}

void notifyEvent(const uint8_t* payload, size_t plen) {
  if (!chEvent || !bleConnected) return;
  chEvent->setValue(payload, plen);
  chEvent->notify();
}

// ===================== params + NVS (§8.1) =================================
void paramsSetDefaults() {
  params.beamDebounceUs      = 15000;
  params.thresholdCm         = 100;
  params.standaloneTimeoutMs = 30000;
  params.rebroadcastN        = 2;
  params.setNumber           = 1;      // factory / RESTORE_DEFAULTS → Set 1 (ch1), zero-config
}
// Clamp on EVERY apply path — SET_PARAM write AND NVS load — so a structurally
// valid but garbage persisted value degrades to a boundary, never out of spec.
void clampParams() {
  params.beamDebounceUs      = clampU32(params.beamDebounceUs, 1000, 200000);
  params.thresholdCm         = (uint16_t)clampU32(params.thresholdCm, 10, 800);
  params.standaloneTimeoutMs = clampU32(params.standaloneTimeoutMs, 3000, 600000);
  params.rebroadcastN        = (uint8_t)clampU32(params.rebroadcastN, 1, 5);
  params.setNumber           = (uint8_t)clampU32(params.setNumber, 1, 3);   // garbage → legal channel
}
// Arduino core runs nvs_flash_init (with erase-on-error) before setup(), so
// partition-level self-heal is handled. We add a magic+version+CRC blob so we
// never trust NVS bytes that aren't provably ours → fall back to defaults.
// g1: accepts ver 1 (f2-FROZEN) AND ver 2 blobs. Both share magic, CRC algorithm,
// size, and every shared field offset (setNumber sits in v1's zero-padding — see
// the static_asserts). A v1 blob is MIGRATED: tuned params kept, setNumber
// defaulted to 1, then re-saved once as ver 2 so the upgrade is one-shot
// (SETS-G1 §3, per Louis: don't silently wipe tuned units on reflash).
void paramsLoad() {
  paramsSetDefaults();
  bool migrate = false;
  if (!prefs.begin("gate", true)) { return; }   // namespace missing → defaults
  PersistBlob b;
  size_t got = prefs.getBytes("params", &b, sizeof(b));
  prefs.end();
  if (got != sizeof(b)) return;
  uint16_t stored = b.crc; b.crc = 0;
  if (b.magic != PARAM_MAGIC || crc16((uint8_t*)&b, sizeof(b)) != stored) return;
  if (b.ver != PARAM_VER && b.ver != 1) return; // unknown future version → defaults
  params = b.p;
  if (b.ver == 1) { params.setNumber = 1; migrate = true; }
  clampParams();
  if (migrate) {
    paramsSave();                               // one-shot rewrite as a ver-2 blob
    Serial.println("[param] migrated f2 (v1) blob — tuned params kept, set=1");
  }
}
void paramsSave() {
  PersistBlob b;
  memset(&b, 0, sizeof(b));                       // deterministic padding for CRC
  b.magic = PARAM_MAGIC; b.ver = PARAM_VER; b.p = params; b.crc = 0;
  b.crc = crc16((uint8_t*)&b, sizeof(b));
  if (!prefs.begin("gate", false)) return;
  prefs.putBytes("params", &b, sizeof(b));
  prefs.end();
  Serial.println("[param] persisted to NVS");
}
void paramsRestoreDefaults() {
  paramsSetDefaults();
  if (prefs.begin("gate", false)) { prefs.remove("params"); prefs.end(); }
  Serial.println("[param] restored defaults (NVS cleared)");
}
void applyParam(uint16_t pid, uint32_t val) {
  switch (pid) {
    case PID_BEAM_DEBOUNCE_US:  params.beamDebounceUs = val; break;
    case PID_THRESHOLD_CM:      params.thresholdCm = (uint16_t)val; break;
    case PID_STANDALONE_TMO_MS: params.standaloneTimeoutMs = val; break;
    case PID_EVENT_REBROADCAST: params.rebroadcastN = (uint8_t)val; break;
    case PID_SET_NUMBER:        params.setNumber = (uint8_t)val; break;   // takes effect NEXT boot
    default: return;                               // reserved / unknown = no-op
  }
  clampParams();
  Serial.printf("[param] set 0x%04X = %lu\n", pid, (unsigned long)val);
}

// ===================== Luna UART ===========================================
void setLunaFrameRate(uint8_t fps) {
  uint8_t cmd[] = {0x5A, 0x06, 0x03, fps, 0x00, 0x00};
  uint16_t sum = 0;
  for (int i = 0; i < 5; i++) sum += cmd[i];
  cmd[5] = sum & 0xFF;
  Serial2.write(cmd, 6);
  delay(100);
}
bool readLuna(int16_t &dist) {
  while (Serial2.available() >= 9) {
    if (Serial2.read() == 0x59) {
      if (Serial2.peek() == 0x59) {
        Serial2.read();
        uint8_t buf[7];
        if (Serial2.readBytes(buf, 7) != 7) return false;
        uint8_t checksum = 0x59 + 0x59;
        for (int i = 0; i < 6; i++) checksum += buf[i];
        if (checksum == buf[6]) { dist = buf[0] | (buf[1] << 8); return true; }
      }
    }
  }
  return false;
}

// ===================== ESP-NOW callbacks ===================================
void onDataSent(const wifi_tx_info_t *info, esp_now_send_status_t status) { (void)info; (void)status; }
void onDataRecv(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  v2StageInbound(data, len, info->src_addr);   // src MAC rides along for peer tracking
}

// ===================== event emit ==========================================
uint8_t v2QueueDepth() { return (uint8_t)((evQHead - evQTail + V2_QUEUE_LEN) % V2_QUEUE_LEN); }

void v2Enqueue7(const uint8_t* f) {
  memcpy(evQ[evQHead], f, 7);
  uint16_t nh = (evQHead + 1) % V2_QUEUE_LEN;
  if (nh == evQTail) evQTail = (evQTail + 1) % V2_QUEUE_LEN;   // drop oldest
  evQHead = nh;
}

// A locally-detected event: queue for BLE relay, broadcast to peers (copy 1 now,
// copies 2..N spaced), and feed our own standalone consumer (local origin).
void v2EmitLocalEvent(uint8_t type, uint32_t sharedUs, uint8_t flags) {
  uint8_t f[7];
  f[0] = type; f[1] = v2GateId; putU32(&f[2], sharedUs); f[6] = flags;
  v2Enqueue7(f);
  esp_now_send(bcastMAC, f, 7);
  rebSchedule(f, params.rebroadcastN > 0 ? (uint8_t)(params.rebroadcastN - 1) : 0);
  saOnEvent(type, true, sharedUs);
}

void v2ServiceQueue() {
  if (!bleConnected) return;
  uint8_t budget = 12;
  while (evQTail != evQHead && budget--) {
    notifyEvent(evQ[evQTail], 7);
    evQTail = (evQTail + 1) % V2_QUEUE_LEN;
  }
}

void rebSchedule(const uint8_t* f, uint8_t copies) {
  if (copies == 0) return;
  for (int i = 0; i < REB_SLOTS; i++) {
    if (!rebRing[i].active) {
      memcpy(rebRing[i].f, f, 7);
      rebRing[i].dueMs = millis() + REB_SPACING_MS;
      rebRing[i].left = copies;
      rebRing[i].active = true;
      return;
    }
  }
  // ring full: drop the extra copies (best-effort; the first copy already went)
}
void rebService(unsigned long now) {
  for (int i = 0; i < REB_SLOTS; i++) {
    if (rebRing[i].active && (long)(now - rebRing[i].dueMs) >= 0) {
      esp_now_send(bcastMAC, rebRing[i].f, 7);
      if (--rebRing[i].left == 0) rebRing[i].active = false;
      else rebRing[i].dueMs = now + REB_SPACING_MS;
    }
  }
}

// Always-on beam edge detector — emits BOTH edges, mode-free.
void v2BeamDetect(int16_t dist, unsigned long nowUs) {
  bool beam = (dist > 0 && dist <= (int)params.thresholdCm);
  if (beam != v2LastBeam && (nowUs - v2DebounceUs) > params.beamDebounceUs) {
    v2DebounceUs = nowUs;
    v2LastBeam = beam;
    v2EmitLocalEvent(beam ? V2_BEAM_BREAK : V2_BEAM_CLEAR, sharedMicros(), 0);
  }
}

// Physical buttons → BUTTON_PRESS (frozen §7, flags 0). B1 also drives the local
// standalone consumer (arm/cancel/re-arm); B2 is reserved but still emits.
void v2ServiceButtons(unsigned long nowMs) {
  // B1: emit BUTTON_PRESS + Mode-1 arm/cancel (edge-debounced; lockout inside saOnB1).
  bool b1 = (digitalRead(BUTTON1_PIN) == LOW);
  if (b1 && !v2B1Last && (nowMs - v2B1Deb) > 200) {
    v2B1Deb = nowMs;
    v2EmitLocalEvent(V2_BUTTON_PRESS, sharedMicros(), 0);
    saOnB1(nowMs);
  }
  v2B1Last = b1;

  // B2: emit on press; a >=300ms hold in READY arms Mode 2 (release = GO). The
  // hold requirement stops a stray B2 tap from starting a Mode-2 run. A B2 tap
  // also dismisses a result (v1 parity: B1 OR B2 leaves the result).
  bool b2 = (digitalRead(BUTTON2_PIN) == LOW);
  if (b2 && !v2B2Last && (nowMs - v2B2Deb) > 200) {   // press edge
    v2B2Deb = nowMs; v2B2PressMs = nowMs;
    v2EmitLocalEvent(V2_BUTTON_PRESS, sharedMicros(), 0);
    if (saState == SA_RESULT && (long)(nowMs - saBtnLockMs) >= 0) {
      saGo(SA_READY); saBtnLockMs = nowMs + SA_BTN_LOCK_MS;
    }
  }
  if (b2 && saState == SA_READY && (nowMs - v2B2PressMs) >= SA_M2_HOLD_MIN_MS) {
    if (otherGateCount(nowMs) <= 1) saGo(SA_M2_HOLD);  // held long enough: release to start
  }                                                    // (stray on channel → refuse, SETS-G1 §5)
  if (!b2 && v2B2Last && saState == SA_M2_HOLD) {      // release edge -> GO
    saOnB2Release();
  }
  v2B2Last = b2;
}

void v2FireBuzzer(uint16_t durMs) {
  digitalWrite(BUZZER_PIN, HIGH);
  buzzerOn = true;
  buzzerOffMs = millis() + durMs;
  v2EmitLocalEvent(V2_BUZZER_FIRED, sharedMicros(), 0);   // GO reference, at fire
}
void v2ServiceBuzzer(unsigned long nowMs) {
  if (buzzerOn && (long)(nowMs - buzzerOffMs) >= 0) { digitalWrite(BUZZER_PIN, LOW); buzzerOn = false; }
}

// Self-heartbeat: broadcast (election + peer discovery) + relay to app.
void v2ServiceHeartbeat(unsigned long nowMs) {
  unsigned long iv = (v2GateId == 0) ? 1000UL : 5000UL;
  if ((long)(nowMs - lastHeartbeatMs) < (long)iv) return;
  lastHeartbeatMs = nowMs;
  uint8_t f[8];
  f[0] = V2_HEARTBEAT; memcpy(&f[1], myMac, 6);
  f[7] = bootedSetNumber;                  // membership tag (contract §10, g1-a2)
  esp_now_send(bcastMAC, f, 8);
  notifyEvent(f, 8);
}

void v2SendPingReply(uint32_t appMicros) {
  uint8_t f[9];
  f[0] = V2_PING_REPLY; putU32(&f[1], appMicros); putU32(&f[5], sharedMicros());
  notifyEvent(f, 9);   // PING is bridge-only, so the connected gate always answers
}

// STATUS_REPLY: if we are the connected bridge, notify the app directly; if we
// are a remote target, broadcast so the bridge relays it (§8 relay model).
void v2SendStatusSelf() {
  uint8_t f[8];
  f[0] = V2_STATUS_REPLY; f[1] = v2GateId;
  f[2] = params.thresholdCm & 0xFF; f[3] = (params.thresholdCm >> 8) & 0xFF;
  f[4] = 0xFF;                       // battery: not sensed
  f[5] = v2QueueDepth();
  f[6] = V2_FW_VER;
  uint8_t caps = 0x02;               // bit1 has_buttons (assumed on our units)
  if (has_display) caps |= 0x01;     // bit0 has_display (feature-detected)
  if (timeSynced)  caps |= 0x08;     // bit3 time_synced (bit2 buzzer_wired = 0)
  caps |= (uint8_t)((bootedSetNumber & 0x07) << 4);        // bits4-6: ACTIVE set (g1+)
  if (params.setNumber != bootedSetNumber) caps |= 0x80;   // bit7: reboot pending
  f[7] = caps;
  if (bleConnected) notifyEvent(f, 8);
  else esp_now_send(bcastMAC, f, 8);
}

// Master answers a follower's TIME_SYNC ping with our local micros as t2.
void v2SendPong(const uint8_t* pingFrame) {
  uint8_t f[14];
  f[0] = V2_TIME_SYNC; f[1] = TS_PONG;
  memcpy(&f[2], &pingFrame[2], 4);     // echo seq
  memcpy(&f[6], &pingFrame[6], 4);     // echo t1
  putU32(&f[10], (uint32_t)micros());  // t2 (master local == shared clock)
  esp_now_send(bcastMAC, f, 14);
}
// Follower: apply a master's TS_PONG (min-RTT filtered) → shared-clock offset.
void v2ApplyPong(const uint8_t* f) {
  uint32_t seq = rd32(&f[2]);
  if (seq != tsSeq) return;
  uint32_t t1 = rd32(&f[6]);
  uint32_t t2 = rd32(&f[10]);
  uint32_t t4 = (uint32_t)micros();
  uint32_t rtt = (uint32_t)(t4 - t1);
  if (rtt > 50000UL) return;
  if (rtt < tsMinRtt) {
    tsMinRtt = rtt;
    uint32_t midpoint = t1 + rtt / 2;
    clkOffset = (int32_t)(t2 - midpoint);
    timeSynced = true;
  }
}
// Follower pings the network; the master answers. Master never pings.
void v2ServiceTimeSync(unsigned long nowMs) {
  if (isMaster) return;
  if ((long)(nowMs - lastTsResetMs) >= 10000) { lastTsResetMs = nowMs; tsMinRtt = 0xFFFFFFFFUL; }
  if ((long)(nowMs - lastTsPingMs) < 1000) return;   // 1s cadence — eases radio load
  lastTsPingMs = nowMs;
  tsSeq++;
  uint8_t f[14];
  f[0] = V2_TIME_SYNC; f[1] = TS_PING;
  putU32(&f[2], tsSeq); putU32(&f[6], (uint32_t)micros()); putU32(&f[10], 0);
  esp_now_send(bcastMAC, f, 14);
}

// Lowest-MAC election. Master = our MAC is the lowest we've heard.
void updateElection() {
  bool nowMaster = (memcmp(myMac, lowestMac, 6) == 0);
  if (nowMaster == isMaster) return;
  isMaster = nowMaster;
  Serial.printf("[v2] election -> %s (lowest %02X:%02X:%02X:%02X:%02X:%02X)\n",
                isMaster ? "MASTER" : "follower",
                lowestMac[0], lowestMac[1], lowestMac[2], lowestMac[3], lowestMac[4], lowestMac[5]);
  if (isMaster) { clkOffset = 0; timeSynced = true; }
  else { tsMinRtt = 0xFFFFFFFFUL; timeSynced = false; lastTsResetMs = millis(); }
}
void noteMac(const uint8_t* mac) {
  if (memcmp(mac, lowestMac, 6) < 0) { memcpy(lowestMac, mac, 6); updateElection(); }
}

// Received-event dedup: N-rebroadcast + relay would otherwise double-count.
bool v2SeenEvent(const uint8_t* f) {
  uint8_t key[6]; key[0] = f[0]; key[1] = f[1]; memcpy(&key[2], &f[2], 4);
  for (int i = 0; i < SEEN_SLOTS; i++) if (memcmp(seenKey[i], key, 6) == 0) return true;
  memcpy(seenKey[seenIdx], key, 6); seenIdx = (seenIdx + 1) % SEEN_SLOTS;
  return false;
}

void v2Rebroadcast(const uint8_t* f, uint8_t len) { esp_now_send(bcastMAC, f, len); }

void v2DoAssignIds(const uint8_t* f, uint8_t len) {
  if (len < 2) return;
  uint8_t count = f[1];
  uint8_t p = 2;
  for (uint8_t i = 0; i < count && (uint8_t)(p + 7) <= len; i++, p += 7) {
    bool match = true;
    for (uint8_t b = 0; b < 6; b++) if (f[p + b] != myMac[b]) { match = false; break; }
    if (match) v2GateId = f[p + 6];
  }
}

// SET_PARAM (§8.1): target-matched apply (clamped), optional NVS persist,
// param_id 0 = restore defaults.
void v2DoSetParam(const uint8_t* f, uint8_t len) {
  if (len < 9) return;
  uint8_t tgt = f[1];
  uint8_t flags = f[2];
  uint16_t pid = (uint16_t)(f[3] | (f[4] << 8));
  uint32_t val = rd32(&f[5]);
  if (!(tgt == v2GateId || tgt == GATE_ID_ALL)) return;
  if (pid == PID_RESTORE_DEFAULTS) { paramsRestoreDefaults(); return; }
  applyParam(pid, val);
  // SET_NUMBER is ALWAYS persisted (contract §8.1): the value only has meaning
  // across a reboot, so a RAM-only write would be semantically void.
  if ((flags & 0x01) || pid == PID_SET_NUMBER) paramsSave();
}

// One executor for both origins. fromBle=true (app write) re-broadcasts targeted
// commands so the OTHER gate self-matches; fromBle=false (arrived over ESP-NOW
// from the bridge) executes locally only — no re-broadcast, no loop.
void v2ExecCommand(const uint8_t* f, uint8_t len, bool fromBle) {
  if (len < 1) return;
  switch (f[0]) {
    case V2_ASSIGN_IDS:
      v2DoAssignIds(f, len);
      if (fromBle) v2Rebroadcast(f, len);
      break;
    case V2_SET_THRESHOLD:
      if (len >= 4) { uint8_t tgt = f[1]; if (tgt == v2GateId || tgt == GATE_ID_ALL) { params.thresholdCm = (uint16_t)(f[2] | (f[3] << 8)); clampParams(); } }
      if (fromBle) v2Rebroadcast(f, len);
      break;
    case V2_BUZZER_FIRE:
      if (len >= 5) { uint8_t tgt = f[1]; if (tgt == v2GateId || tgt == GATE_ID_ALL) v2FireBuzzer((uint16_t)(f[2] | (f[3] << 8))); }
      if (fromBle) v2Rebroadcast(f, len);
      break;
    case V2_CLEAR_QUEUE:
      if (len >= 2) { uint8_t tgt = f[1]; if (tgt == v2GateId || tgt == GATE_ID_ALL) evQTail = evQHead; }
      if (fromBle) v2Rebroadcast(f, len);
      break;
    case V2_PING:
      if (fromBle && len >= 5) v2SendPingReply(rd32(&f[1]));   // bridge-only
      break;
    case V2_GET_STATUS:
      if (len >= 2) { uint8_t tgt = f[1]; if (tgt == v2GateId || tgt == GATE_ID_ALL) v2SendStatusSelf(); }
      if (fromBle) v2Rebroadcast(f, len);
      break;
    case V2_SET_PARAM:
      v2DoSetParam(f, len);
      if (fromBle) v2Rebroadcast(f, len);
      break;
    case V2_RUN_HINT:
      if (len >= 3) { uint8_t tgt = f[1]; if (tgt == v2GateId || tgt == GATE_ID_ALL) saOnRunHint(f[2] != 0); }
      if (fromBle) v2Rebroadcast(f, len);        // relay so the other display gate mirrors too
      break;
    default: break;
  }
}

void v2HandleCommand() {
  if (!v2CmdPending) return;
  v2CmdPending = false;
  v2ExecCommand(v2CmdBuf, v2CmdLen, true);
}

// A v2 frame arrived over ESP-NOW from another gate.
void v2HandleFrame(const uint8_t* f, uint8_t len) {
  uint8_t t = f[0];
  if (t >= V2_BEAM_BREAK && t <= 0x0F) {                 // event from another gate
    if (len >= 7 && !v2SeenEvent(f)) {
      v2Enqueue7(f);                                     // relay to app (bridge)
      saOnEvent(t, false, rd32(&f[2]));                  // feed standalone (remote)
    }
    return;
  }
  if (t >= V2_ASSIGN_IDS && t <= 0x3F) {                 // command relayed by the bridge
    v2ExecCommand(f, len, false);
    return;
  }
  switch (t) {
    // V2_HEARTBEAT never reaches here — it is consumed by the membership front
    // door in v2ProcessInbound (classify → same-set only: noteMac + relay).
    case V2_TIME_SYNC:
      if (len >= 14 && f[1] == TS_PONG) { if (!isMaster) v2ApplyPong(f); }
      else if (len >= 10 && f[1] == TS_PING) { if (isMaster) v2SendPong(f); }
      break;
    case V2_STATUS_REPLY:
      if (len >= 8) notifyEvent(f, 8);                   // relay a remote gate's status
      break;
    case V2_PING_REPLY:
      if (len >= 9) notifyEvent(f, 9);
      break;
    default: break;
  }
}

void v2StageInbound(const uint8_t* d, int len, const uint8_t* srcMac) {
  if (len < 1 || len > 32) return;
  uint8_t nh = (v2RxHead + 1) % V2_RX_SLOTS;
  if (nh == v2RxTail) return;            // full: drop
  memcpy(v2Rx[v2RxHead], d, len);
  memcpy(v2RxMac[v2RxHead], srcMac, 6);
  v2RxLen[v2RxHead] = (uint8_t)len;
  v2RxHead = nh;
}
// The membership front door (SETS-G1 §5b). Heartbeats are ALWAYS processed —
// they are the classifier; a foreign heartbeat classifies its sender and STOPS
// (no election noteMac, no BLE relay, no count). Every other frame is dropped
// unless its radio-level sender is a classified same-set member. This sits
// before the standalone consumer, the election, the relay, and the count, so
// cross-channel leakage cannot reach any of them. Runs loop()-side (frames +
// src MACs are staged by the recv callback), so no concurrency edges.
void v2ProcessInbound() {
  while (v2RxTail != v2RxHead) {
    uint8_t* f   = v2Rx[v2RxTail];
    uint8_t  len = v2RxLen[v2RxTail];
    uint8_t* src = v2RxMac[v2RxTail];
    unsigned long now = millis();
    if (f[0] == V2_HEARTBEAT && len >= 7) {
      uint8_t hbSet = (len >= 8) ? f[7] : 1;   // 7-byte (f2) heartbeat = implicit Set 1
      notePeerHeartbeat(src, hbSet, now);
      if (hbSet == bootedSetNumber) {          // same set: election + app discovery
        noteMac(&f[1]);
        notifyEvent(f, len);
      }
    } else if (peerVerdict(src, now) == 1) {
      v2HandleFrame(f, len);                   // same-set member: full processing
    }                                          // foreign/unknown sender: dropped
    v2RxTail = (v2RxTail + 1) % V2_RX_SLOTS;
  }
}

int findPeer(const uint8_t* mac) {
  for (int i = 0; i < PEER_SLOTS; i++)
    if (peerLastMs[i] != 0 && memcmp(peerMacs[i], mac, 6) == 0) return i;
  return -1;
}

// Classify (insert/update) a sender from its HEARTBEAT — the only frame that
// creates table entries. Classification is sticky (§5b two-clock rule); only a
// new heartbeat declaring a different set re-classifies (that gate rebooted).
void notePeerHeartbeat(const uint8_t* mac, uint8_t set, unsigned long now) {
  if (now == 0) now = 1;
  int i = findPeer(mac);
  if (i >= 0) { peerSet[i] = set; peerLastMs[i] = now; return; }
  int slot = -1;
  for (int k = 0; k < PEER_SLOTS && slot < 0; k++)   // empty slot first
    if (peerLastMs[k] == 0) slot = k;
  for (int k = 0; k < PEER_SLOTS && slot < 0; k++)   // then stale foreign
    if (peerSet[k] != bootedSetNumber && (now - peerLastMs[k]) >= PEER_TIMEOUT_MS) slot = k;
  for (int k = 0; k < PEER_SLOTS && slot < 0; k++)   // then any foreign
    if (peerSet[k] != bootedSetNumber) slot = k;
  if (slot < 0) {                                    // all live members: oldest
    slot = 0;
    for (int k = 1; k < PEER_SLOTS; k++) if (peerLastMs[k] < peerLastMs[slot]) slot = k;
  }
  memcpy(peerMacs[slot], mac, 6);
  peerSet[slot] = set;
  peerLastMs[slot] = now;
}

// Front-door verdict for NON-heartbeat frames: -1 unknown, 0 foreign, 1 member.
// Unknown senders are dropped by the caller — accepting them would defeat the
// filter, and the only exposure is the seconds after our own boot, during which
// the consumer is still NO_GATE/SYNCING (READY needs a live classified member).
// A member's liveness refreshes on ANY of its frames, not just heartbeats.
int8_t peerVerdict(const uint8_t* mac, unsigned long now) {
  int i = findPeer(mac);
  if (i < 0) return -1;
  if (peerSet[i] != bootedSetNumber) return 0;
  peerLastMs[i] = now ? now : 1;
  return 1;
}

// How many OTHER same-set gates are live right now. 1 = a normal 2-gate set;
// >1 = a true same-set stray (arming is refused). Foreign sets never count.
uint8_t otherGateCount(unsigned long now) {
  uint8_t n = 0;
  for (int i = 0; i < PEER_SLOTS; i++)
    if (peerLastMs[i] != 0 && peerSet[i] == bootedSetNumber &&
        (now - peerLastMs[i]) < PEER_TIMEOUT_MS) n++;
  return n;
}

// ===================== standalone consumer (§12.1 + Mode 1/2 + mirror) =====
// Origin-keyed: a run is start(one source) -> finish(the OTHER source). Ids are
// irrelevant (they stay 0 with no phone). All interval math is sdiff32. When a
// phone is connected, an unarmed gate mirrors the app-driven run for display.
void pushRecentRun(bool isM2, uint32_t totalMs, uint32_t s1, uint32_t s2) {
  for (int i = RECENT_MAX - 1; i > 0; i--) recent[i] = recent[i - 1];
  recent[0].isM2 = isM2; recent[0].totalMs = totalMs; recent[0].s1Ms = s1; recent[0].s2Ms = s2;
  if (recentCount < 0xFFFF) recentCount++;
}

// Single point of state change for the standalone/mirror consumer. The [sa]
// serial trace that lived here was stripped at freeze; the boot marker stays.
void saGo(SaState s) {
  if (s == saState) return;
  saState = s;
}

// B1: Mode-1 arm / cancel / dismiss. A 500ms post-action lockout (v1's value)
// means a bounce or a nervous second tap can't cancel a run you just started.
void saOnB1(unsigned long nowMs) {
  if ((long)(nowMs - saBtnLockMs) < 0) return;
  switch (saState) {
    case SA_READY:                                             // arm Mode 1 (real) —
      if (otherGateCount(nowMs) <= 1) { saMirror = false; saGo(SA_ARMED); }
      break;                          // >1 other = stray on channel → refuse (screen shows Ng!)
    case SA_ARMED:   saGo(SA_READY); break;                    // cancel arm
    case SA_RUNNING: saMirror = false; saGo(SA_READY); break;  // cancel run / stop mirror
    case SA_M2_HOLD: case SA_M2_RUN1: case SA_M2_RUN2:
                     saMirror = false; saGo(SA_READY); break;  // cancel Mode 2
    case SA_RESULT:  saGo(SA_READY); break;                    // dismiss (recent list updates)
    default: break;                                            // NO_GATE/SYNCING/TIMEOUT: ignore
  }
  saBtnLockMs = nowMs + SA_BTN_LOCK_MS;
}

// B2 released after a hold: the Mode-2 manual GO (someone says "go", releases).
void saOnB2Release() {
  saGoUs = sharedMicros();
  saTimeoutAtMs = millis() + params.standaloneTimeoutMs;
  saMirror = false; saIsM2 = true;
  saGo(SA_M2_RUN1);
}

// RUN_HINT (0x37) — the app telling the gate a run is armed/disarmed, PURELY so
// the OLED can mirror a live run. Display-only: firmware derives NO run semantics
// from it (no splits, no validity — those stay in the event stream + app). Armed
// only from READY, and disarm only ever clears a MIRROR run, never a real B1/B2
// standalone one. This replaces the old "mirror on any beam during a session"
// so a stray person walking a gate between reps no longer starts a phantom timer.
void saOnRunHint(bool armed) {
  if (armed) {
    if (saState == SA_READY && otherGateCount(millis()) <= 1) {  // stray → mirror refused too
      saMirror = true; saIsM2 = false;
      saTimeoutAtMs = millis() + params.standaloneTimeoutMs;   // self-heal if disarm is lost
      saGo(SA_ARMED);
    }
  } else {
    if (saMirror && (saState == SA_ARMED || saState == SA_RUNNING || saState == SA_RESULT)) {
      saMirror = false;
      saGo(SA_READY);
    }
  }
}
void saOnEvent(uint8_t type, bool local, uint32_t us) {
  if (type != V2_BEAM_BREAK) return;              // BEAM_CLEAR/others: run-irrelevant

  if (saState == SA_ARMED) {                      // armed by B1 (real) or RUN_HINT (mirror)
    saIsM2 = false;                               // saMirror already set by whoever armed
    saStartLocal = local; saStartUs = us;
    saTimeoutAtMs = millis() + params.standaloneTimeoutMs;
    saGo(SA_RUNNING); return;
  }
  if (saState == SA_RUNNING) {                    // Mode 1 / mirror finish
    if (local != saStartLocal) {
      int32_t d = sdiff32(us, saStartUs); if (d < 0) d = 0;
      saSplitMs = (uint32_t)(((uint32_t)d + 500) / 1000);
      saIsM2 = false;
      if (!saMirror) pushRecentRun(false, saSplitMs, 0, 0);
      saShownMs = millis(); saGo(SA_RESULT);
    }
    return;
  }
  if (saState == SA_M2_RUN1) {                    // Mode 2 leg 1: GO -> first gate
    saStartLocal = local; saStartUs = us;
    int32_t d = sdiff32(us, saGoUs); if (d < 0) d = 0;
    saSplit1Ms = (uint32_t)(((uint32_t)d + 500) / 1000);
    saTimeoutAtMs = millis() + params.standaloneTimeoutMs;
    saGo(SA_M2_RUN2); return;
  }
  if (saState == SA_M2_RUN2) {                    // Mode 2 leg 2: the OTHER gate finishes
    if (local != saStartLocal) {
      int32_t d2 = sdiff32(us, saStartUs); if (d2 < 0) d2 = 0;
      saSplit2Ms = (uint32_t)(((uint32_t)d2 + 500) / 1000);
      int32_t dt = sdiff32(us, saGoUs); if (dt < 0) dt = 0;
      saSplitMs = (uint32_t)(((uint32_t)dt + 500) / 1000);
      saIsM2 = true;
      pushRecentRun(true, saSplitMs, saSplit1Ms, saSplit2Ms);
      saShownMs = millis(); saGo(SA_RESULT);
    }
    return;
  }
}
void saService(unsigned long now) {
  bool peer   = otherGateCount(now) >= 1;   // any live partner (strays gate ARMING, not READY)
  bool synced = timeSynced;
  // Pre-run states track peer/sync: NO_GATE (go check the 2nd gate) vs SYNCING
  // (wait) vs READY. A lone gate can't split, so READY needs a peer, not just sync.
  if (saState == SA_NO_GATE || saState == SA_SYNCING || saState == SA_READY) {
    saGo(!peer ? SA_NO_GATE : (!synced ? SA_SYNCING : SA_READY));
  } else if (saState == SA_ARMED) {
    if (!peer || !synced) saGo(!peer ? SA_NO_GATE : SA_SYNCING);            // lost readiness
    else if (saMirror && (long)(now - saTimeoutAtMs) >= 0) saGo(SA_READY);  // stale mirror-arm
  } else if (saState == SA_RUNNING || saState == SA_M2_RUN1 || saState == SA_M2_RUN2) {
    if ((long)(now - saTimeoutAtMs) >= 0) {
      if (saMirror) saGo(SA_READY);               // mirror: silently drop, no error shown
      else { saShownMs = now; saGo(SA_TIMEOUT); }
    }
  } else if (saState == SA_RESULT) {
    if (saMirror && (long)(now - saShownMs) >= (long)SA_RESULT_AUTOCLEAR_MS) saGo(SA_READY);
  } else if (saState == SA_TIMEOUT) {
    if ((long)(now - saShownMs) >= 2000) saGo(SA_READY);   // re-evaluated next pass
  }
  // SA_M2_HOLD is left via the B2 release edge (or a B1 cancel) in v2ServiceButtons.
}
void saRender() {
  // redraw key: state + a value (running bucket / result / recent count) so the
  // OLED isn't thrashed. Typography/positions are lifted from gate1_ble b8.
  char key[28];
  uint8_t others = otherGateCount(millis());                    // g1: live gate count
  bool    pend   = (params.setNumber != bootedSetNumber);       // g1: reboot pending
  switch (saState) {
    case SA_NO_GATE: strcpy(key, "nogate"); break;
    case SA_SYNCING: strcpy(key, "sync"); break;
    case SA_READY:   snprintf(key, sizeof(key), "rdy%u_%u_%u", (unsigned)recentCount,
                              (unsigned)others, pend ? 1u : 0u); break;
    case SA_ARMED:   strcpy(key, "armed"); break;
    case SA_M2_HOLD: strcpy(key, "m2hold"); break;
    case SA_TIMEOUT: strcpy(key, "tmo"); break;
    case SA_RESULT:  snprintf(key, sizeof(key), "res%d%lu", saIsM2 ? 2 : 1, (unsigned long)saSplitMs); break;
    case SA_RUNNING: { int32_t d = sdiff32(sharedMicros(), saStartUs); if (d < 0) d = 0;
                       snprintf(key, sizeof(key), "run%c%lu", saMirror ? 'm' : 's', (unsigned long)((uint32_t)d / 100000)); break; }
    case SA_M2_RUN1: { int32_t d = sdiff32(sharedMicros(), saGoUs); if (d < 0) d = 0;
                       snprintf(key, sizeof(key), "m2a%lu", (unsigned long)((uint32_t)d / 100000)); break; }
    case SA_M2_RUN2: { int32_t d = sdiff32(sharedMicros(), saGoUs); if (d < 0) d = 0;
                       snprintf(key, sizeof(key), "m2b%lu", (unsigned long)((uint32_t)d / 100000)); break; }
    default: strcpy(key, "?"); break;
  }
  if (strcmp(key, lastRender) == 0) return;
  strncpy(lastRender, key, sizeof(lastRender) - 1);
  lastRender[sizeof(lastRender) - 1] = '\0';

  u8g2.clearBuffer();
  u8g2.setFont(u8g2_font_ncenB08_tr);
  char b[40];
  switch (saState) {
    case SA_NO_GATE:                              // connecting screen (gate 1 up before gate 2).
      u8g2.drawStr(0, 10, "not connected yet");   // Each gate NAMES ITS SET here, so a
      u8g2.setFont(u8g2_font_ncenB14_tr); u8g2.drawStr(0, 34, "NO GATE");   // mismatched-set
      u8g2.setFont(u8g2_font_ncenB08_tr);                                   // pair is visible
      sprintf(b, "check 2nd gate   S%u", (unsigned)bootedSetNumber);        // on the glass.
      u8g2.drawStr(0, 54, b);
      break;
    case SA_SYNCING:
      u8g2.drawStr(0, 10, "not connected yet");
      u8g2.setFont(u8g2_font_ncenB18_tr); u8g2.drawStr(0, 40, "SYNCING");
      u8g2.setFont(u8g2_font_ncenB08_tr);
      sprintf(b, "S%u", (unsigned)bootedSetNumber);
      u8g2.drawStr(112, 60, b);
      break;
    case SA_READY: {                              // v1 idle screen: header + last 3 runs.
      // g1 header: set + live gate count replace the word READY (the runs list makes
      // the state unambiguous). total != 2 → "!" (stray or missing partner);
      // pending set change → reboot instruction instead.
      if (pend)
        sprintf(b, "S%u>%u  REBOOT GATES", (unsigned)bootedSetNumber, (unsigned)params.setNumber);
      else
        sprintf(b, "S%u %ug%s B1=M1 B2=M2", (unsigned)bootedSetNumber, (unsigned)(others + 1),
                (others + 1) != 2 ? "!" : " ");
      u8g2.drawStr(0, 10, b);
      u8g2.drawHLine(0, 13, 128);
      int y = 25, shown = 0;
      for (int i = 0; i < RECENT_MAX && i < (int)recentCount && shown < 3; i++, shown++) {
        RunRec& r = recent[i];
        int idx = (int)recentCount - i;
        if (!r.isM2) { sprintf(b, "%d: %.3fs  M1", idx, r.totalMs / 1000.0); u8g2.drawStr(0, y, b); y += 13; }
        else { sprintf(b, "%d: Tot:%.3fs M2", idx, r.totalMs / 1000.0); u8g2.drawStr(0, y, b); y += 11;
               sprintf(b, "   S1:%.2f S2:%.2f", r.s1Ms / 1000.0, r.s2Ms / 1000.0); u8g2.drawStr(0, y, b); y += 11; }
      }
      if (recentCount == 0) u8g2.drawStr(15, 38, "No runs yet.");
      break;
    }
    case SA_ARMED:                                // v1 Mode-1 ACTIVATED
      u8g2.drawStr(0, 10, "MODE 1");
      u8g2.setFont(u8g2_font_ncenB14_tr); u8g2.drawStr(5, 38, "ACTIVATED");
      u8g2.setFont(u8g2_font_ncenB08_tr); u8g2.drawStr(0, 56, "Run through Gate 1");
      break;
    case SA_M2_HOLD:                              // v1 "RELEASE TO START"
      u8g2.drawStr(0, 10, "MODE 2");
      u8g2.setFont(u8g2_font_ncenB18_tr); u8g2.drawStr(0, 35, "RELEASE");
      u8g2.setFont(u8g2_font_ncenB10_tr); u8g2.drawStr(0, 52, "TO START");
      break;
    case SA_RUNNING: {                            // v1 drawLiveTimer (%.1fs)
      int32_t d = sdiff32(sharedMicros(), saStartUs); if (d < 0) d = 0;
      sprintf(b, "%.1fs", ((uint32_t)d) / 1000000.0);
      u8g2.drawStr(0, 10, saMirror ? "RUNNING (app)" : "MODE 1 - RUNNING");
      u8g2.setFont(u8g2_font_ncenB24_tr); u8g2.drawStr(5, 50, b);
      break;
    }
    case SA_M2_RUN1: {
      int32_t d = sdiff32(sharedMicros(), saGoUs); if (d < 0) d = 0;
      sprintf(b, "%.1fs", ((uint32_t)d) / 1000000.0);
      u8g2.drawStr(0, 10, "MODE 2 - TO GATE 1");
      u8g2.setFont(u8g2_font_ncenB24_tr); u8g2.drawStr(5, 50, b);
      break;
    }
    case SA_M2_RUN2: {
      int32_t d = sdiff32(sharedMicros(), saGoUs); if (d < 0) d = 0;
      sprintf(b, "%.1fs", ((uint32_t)d) / 1000000.0);
      u8g2.drawStr(0, 10, "MODE 2 - TO GATE 2");
      u8g2.setFont(u8g2_font_ncenB24_tr); u8g2.drawStr(5, 50, b);
      break;
    }
    case SA_RESULT:
      if (saIsM2) {                              // v1 Mode-2 multi-split result
        u8g2.drawStr(0, 10, "MODE 2  RESULT");
        sprintf(b, "S1: %.3fs", saSplit1Ms / 1000.0); u8g2.drawStr(0, 24, b);
        sprintf(b, "S2: %.3fs", saSplit2Ms / 1000.0); u8g2.drawStr(0, 38, b);
        sprintf(b, "Total: %.3fs", saSplitMs / 1000.0); u8g2.drawStr(0, 52, b);
        if (!saMirror) u8g2.drawStr(0, 63, "Press button to cont.");
      } else {                                   // v1 Mode-1 result (%.3fs)
        sprintf(b, "%.3fs", saSplitMs / 1000.0);
        u8g2.drawStr(0, 10, saMirror ? "RESULT (app)" : "MODE 1  RESULT");
        u8g2.setFont(u8g2_font_ncenB18_tr); u8g2.drawStr(0, 36, b);
        u8g2.setFont(u8g2_font_ncenB08_tr);
        if (!saMirror) u8g2.drawStr(0, 56, "Press button to cont.");
      }
      break;
    case SA_TIMEOUT:
      u8g2.drawStr(0, 10, "run timed out");
      u8g2.setFont(u8g2_font_ncenB24_tr); u8g2.drawStr(20, 44, "-- --");
      u8g2.setFont(u8g2_font_ncenB08_tr); u8g2.drawStr(0, 60, "no finish");
      break;
    default: break;
  }
  u8g2.sendBuffer();
}

// ===================== feature detect ======================================
bool detectDisplay() {
  Wire.beginTransmission(OLED_I2C_ADDR);
  return (Wire.endTransmission() == 0);
}

// ===================== BLE =================================================
class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* s, NimBLEConnInfo& info) override {
    (void)s;
    bleConnected = true;
    Serial.println("BLE central connected");
    pendingConnHandle = info.getConnHandle();
    connParamDueMs = millis() + CONN_PARAM_DELAY_MS;
    connParamPending = true;
  }
  void onDisconnect(NimBLEServer* s, NimBLEConnInfo& info, int reason) override {
    (void)s; (void)info; (void)reason;
    bleConnected = false;
    connParamPending = false;
    Serial.println("BLE central disconnected — re-advertising");
    NimBLEDevice::startAdvertising();
  }
};

// Runs on the NimBLE task — only stash the frame; loop() executes it.
class CommandCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* c, NimBLEConnInfo& info) override {
    (void)info;
    std::string v = c->getValue();
    if (v.size() < 1) return;
    size_t n = v.size(); if (n > sizeof(v2CmdBuf)) n = sizeof(v2CmdBuf);
    memcpy(v2CmdBuf, v.data(), n);
    v2CmdLen = (uint8_t)n;
    v2CmdPending = true;              // set last so loop() sees the buffer first
  }
};

void setupBLE() {
  NimBLEDevice::init("EqualSplit-Gate");
  NimBLEDevice::setPower(ESP_PWR_LVL_P9);
  NimBLEServer* server = NimBLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());
  NimBLEService* svc = server->createService(UUID_SERVICE);
  NimBLECharacteristic* chCmd = svc->createCharacteristic(UUID_COMMAND, NIMBLE_PROPERTY::WRITE);
  chCmd->setCallbacks(new CommandCallbacks());
  chEvent = svc->createCharacteristic(UUID_EVENT, NIMBLE_PROPERTY::NOTIFY);
  svc->start();
  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  adv->addServiceUUID(UUID_SERVICE);   // app scans by service UUID, not name
  adv->enableScanResponse(true);
  NimBLEDevice::startAdvertising();
  Serial.println("BLE advertising as EqualSplit-Gate");
}

// Fire the deferred 15ms conn-interval request once, after the link settles.
void serviceConnParam() {
  if (!connParamPending) return;
  if (!bleConnected) { connParamPending = false; return; }
  if ((long)(millis() - connParamDueMs) < 0) return;
  connParamPending = false;
  NimBLEServer* s = NimBLEDevice::getServer();
  if (!s) return;
  s->updateConnParams(pendingConnHandle, 12, 12, 0, 400);   // 15ms, 4s timeout
}

// ===================== setup / loop ========================================
void setup() {
  Serial.begin(115200);
  delay(150);
  Serial.printf("\n[boot] EqualSplit %s | compiled %s %s\n", FW_BUILD, __DATE__, __TIME__);

  Serial2.begin(115200, SERIAL_8N1, LUNA_RX, LUNA_TX);

  Wire.begin(21, 22);
  Wire.setClock(400000);
  has_display = detectDisplay();
  Serial.printf("[boot] display %s\n", has_display ? "detected" : "absent");
  if (has_display) u8g2.begin();

  pinMode(BUTTON1_PIN, INPUT_PULLUP);
  pinMode(BUTTON2_PIN, INPUT_PULLUP);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);

  // Params BEFORE the splash (g1): the splash shows the set number, and the radio
  // channel derives from the loaded set. A held B1 at boot restores defaults —
  // incl. Set 1/ch1 the SAME boot — the non-BLE recovery path (§8.1, SETS-G1 §4).
  paramsLoad();
  if (digitalRead(BUTTON1_PIN) == LOW) {
    Serial.println("[boot] B1 held — restoring default params");
    paramsRestoreDefaults();
    if (has_display) {
      u8g2.clearBuffer();
      u8g2.setFont(u8g2_font_ncenB10_tr);
      u8g2.drawStr(0, 24, "PARAMS");
      u8g2.drawStr(0, 44, "RESET");
      u8g2.sendBuffer();
      delay(800);
    }
  }
  clampParams();
  bootedSetNumber = params.setNumber;                 // the set this boot runs on
  espnowChannel   = setToChannel(bootedSetNumber);    // reboot-to-apply: fixed for this boot
  Serial.printf("[boot] set %u -> ch %u\n", bootedSetNumber, espnowChannel);

  if (has_display) {
    u8g2.clearBuffer();
    u8g2.setFont(u8g2_font_ncenB14_tr);
    u8g2.drawStr(5, 35, "EqualSplit");
    u8g2.setFont(u8g2_font_ncenB08_tr);
    char sb[10];
    sprintf(sb, "SET %u", (unsigned)bootedSetNumber);
    u8g2.drawStr(48, 55, sb);
    u8g2.sendBuffer();
    delay(1500);
  }

  setLunaFrameRate(250);

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);                                         // radio awake for ESP-NOW RX (§15)
  esp_wifi_set_channel(espnowChannel, WIFI_SECOND_CHAN_NONE);   // pin the SET's channel (g1)

  esp_err_t macErr = esp_efuse_mac_get_default(myMac);          // eFuse MAC (valid this early)
  Serial.printf("[boot] MAC %02X:%02X:%02X:%02X:%02X:%02X (efuse err=%d)\n",
                myMac[0], myMac[1], myMac[2], myMac[3], myMac[4], myMac[5], macErr);
  memcpy(lowestMac, myMac, 6);           // election seed: master until we hear lower

  if (esp_now_init() != ESP_OK) {
    Serial.println("ESP-NOW init FAILED");
    if (has_display) {
      u8g2.clearBuffer();
      u8g2.setFont(u8g2_font_ncenB10_tr);
      u8g2.drawStr(0, 20, "ESP-NOW");
      u8g2.drawStr(0, 40, "Error!");
      u8g2.sendBuffer();
    }
    return;
  }
  esp_now_register_send_cb(onDataSent);
  esp_now_register_recv_cb(onDataRecv);

  esp_now_peer_info_t bpeer = {};
  memcpy(bpeer.peer_addr, bcastMAC, 6);
  bpeer.channel = espnowChannel;
  bpeer.encrypt = false;
  if (esp_now_add_peer(&bpeer) != ESP_OK) Serial.println("Failed to add broadcast peer");

  setupBLE();                                                   // after ESP-NOW (coex, §10)
  WiFi.setSleep(false);                                         // re-assert: BLE coex can re-enable PS
  esp_wifi_set_channel(espnowChannel, WIFI_SECOND_CHAN_NONE);

  saState = SA_SYNCING;
  Serial.println("[boot] ready");
}

void loop() {
  unsigned long now = millis();

  serviceConnParam();
  v2HandleCommand();        // consume a v2 command stashed by the NimBLE task
  v2ProcessInbound();       // handle/relay frames from other gates (ESP-NOW)
  v2ServiceButtons(now);    // BUTTON_PRESS + local standalone arm
  v2ServiceBuzzer(now);     // drop the buzzer pin when its pulse ends
  v2ServiceHeartbeat(now);  // self-heartbeat (broadcast + BLE relay)
  v2ServiceTimeSync(now);   // follower: ping the master for the shared clock
  v2ServiceQueue();         // drain the event ring to BLE while connected
  rebService(now);          // fire spaced event retransmits (§12.1.2)

  // LiDAR poll — feeds the always-on beam detector (emit + broadcast + standalone)
  {
    int16_t d;
    while (readLuna(d)) v2BeamDetect(d, micros());
  }

  saService(now);           // standalone state machine (§12.1.1)
  if (has_display && (now - lastDisplayUpdate) > 100) { lastDisplayUpdate = now; saRender(); }
}
