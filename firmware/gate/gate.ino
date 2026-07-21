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
#define FW_BUILD "gate-f2a (write-once)"
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
#define ESPNOW_CHANNEL 1

// ===================== v2 wire constants (FROZEN, §5) =======================
#define V2_FW_VER 2
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

// peer presence (for the standalone NO_GATE vs SYNCING distinction, §12.1.1) —
// stamped whenever ANY frame arrives from another gate. 0 = never heard.
volatile unsigned long peerLastHeardMs = 0;
const unsigned long PEER_TIMEOUT_MS = 5000;

// ===================== runtime params + NVS persistence (§8.1) =============
struct Params {
  uint32_t beamDebounceUs;      // 0x0001
  uint16_t thresholdCm;         // 0x0003 (also settable via SET_THRESHOLD 0x31)
  uint32_t standaloneTimeoutMs; // 0x0004
  uint8_t  rebroadcastN;        // 0x0008 (total sends per event, incl. the first)
};
Params params;
Preferences prefs;
#define PARAM_MAGIC 0x45510001UL      // 'EQ' + rev
#define PARAM_VER   1
struct PersistBlob { uint32_t magic; uint16_t ver; uint16_t crc; Params p; };

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

// ===================== standalone consumer (§12.1) =========================
enum SaState { SA_NO_GATE, SA_SYNCING, SA_READY, SA_ARMED, SA_RUNNING, SA_RESULT, SA_TIMEOUT };
SaState saState = SA_SYNCING;
bool     saStartLocal = false;    // origin of the start edge (local vs received)
uint32_t saStartUs = 0;           // start instant, shared clock
uint32_t saSplitMs = 0;           // last computed split
unsigned long saTimeoutAtMs = 0;  // RUNNING give-up wall time
unsigned long saShownMs = 0;      // transient TIMEOUT display start
unsigned long lastDisplayUpdate = 0;
char lastRender[24] = "";

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
void v2StageInbound(const uint8_t* d, int len);
void v2ProcessInbound();
void saOnButton();
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
}
// Clamp on EVERY apply path — SET_PARAM write AND NVS load — so a structurally
// valid but garbage persisted value degrades to a boundary, never out of spec.
void clampParams() {
  params.beamDebounceUs      = clampU32(params.beamDebounceUs, 1000, 200000);
  params.thresholdCm         = (uint16_t)clampU32(params.thresholdCm, 10, 800);
  params.standaloneTimeoutMs = clampU32(params.standaloneTimeoutMs, 3000, 600000);
  params.rebroadcastN        = (uint8_t)clampU32(params.rebroadcastN, 1, 5);
}
// Arduino core runs nvs_flash_init (with erase-on-error) before setup(), so
// partition-level self-heal is handled. We add a magic+version+CRC blob so we
// never trust NVS bytes that aren't provably ours → fall back to defaults.
void paramsLoad() {
  paramsSetDefaults();
  if (!prefs.begin("gate", true)) { return; }   // namespace missing → defaults
  PersistBlob b;
  size_t got = prefs.getBytes("params", &b, sizeof(b));
  prefs.end();
  if (got != sizeof(b)) return;
  uint16_t stored = b.crc; b.crc = 0;
  if (b.magic != PARAM_MAGIC || b.ver != PARAM_VER || crc16((uint8_t*)&b, sizeof(b)) != stored) return;
  params = b.p;
  clampParams();
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
  (void)info;
  v2StageInbound(data, len);   // v2-only: every inbound frame is a v2 frame
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
  bool b1 = (digitalRead(BUTTON1_PIN) == LOW);
  if (b1 && !v2B1Last && (nowMs - v2B1Deb) > 200) {
    v2B1Deb = nowMs;
    v2EmitLocalEvent(V2_BUTTON_PRESS, sharedMicros(), 0);
    saOnButton();
  }
  v2B1Last = b1;
  bool b2 = (digitalRead(BUTTON2_PIN) == LOW);
  if (b2 && !v2B2Last && (nowMs - v2B2Deb) > 200) {
    v2B2Deb = nowMs;
    v2EmitLocalEvent(V2_BUTTON_PRESS, sharedMicros(), 0);
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
  uint8_t f[7];
  f[0] = V2_HEARTBEAT; memcpy(&f[1], myMac, 6);
  esp_now_send(bcastMAC, f, 7);
  notifyEvent(f, 7);
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
  if (flags & 0x01) paramsSave();
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
    case V2_HEARTBEAT:
      if (len >= 7) { noteMac(&f[1]); notifyEvent(f, 7); }
      break;
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

void v2StageInbound(const uint8_t* d, int len) {
  if (len < 1 || len > 32) return;
  uint8_t nh = (v2RxHead + 1) % V2_RX_SLOTS;
  if (nh == v2RxTail) return;            // full: drop
  memcpy(v2Rx[v2RxHead], d, len);
  v2RxLen[v2RxHead] = (uint8_t)len;
  v2RxHead = nh;
}
void v2ProcessInbound() {
  while (v2RxTail != v2RxHead) {
    peerLastHeardMs = millis();          // any inbound frame = a peer exists
    v2HandleFrame(v2Rx[v2RxTail], v2RxLen[v2RxTail]);
    v2RxTail = (v2RxTail + 1) % V2_RX_SLOTS;
  }
}

// ===================== standalone consumer (§12.1) =========================
// Origin-keyed: the run is start(one source) -> finish(the OTHER source). Ids are
// irrelevant (they stay 0 with no phone). All interval math is sdiff32.
void saOnButton() {
  switch (saState) {
    case SA_NO_GATE: case SA_SYNCING: break;      // can't run — ignore
    case SA_READY:   saState = SA_ARMED; break;
    case SA_ARMED:   saState = SA_READY; break;   // cancel
    case SA_RUNNING: saState = SA_READY; break;   // cancel
    case SA_RESULT:  saState = SA_ARMED; break;   // new run
    case SA_TIMEOUT: break;
  }
}
void saOnEvent(uint8_t type, bool local, uint32_t us) {
  if (type != V2_BEAM_BREAK) return;              // BEAM_CLEAR/others: run-irrelevant
  if (saState == SA_ARMED) {
    saStartLocal = local;
    saStartUs = us;
    saTimeoutAtMs = millis() + params.standaloneTimeoutMs;
    saState = SA_RUNNING;
  } else if (saState == SA_RUNNING) {
    if (local != saStartLocal) {                  // finish must be the OTHER source
      int32_t d = sdiff32(us, saStartUs);
      if (d < 0) d = 0;                           // cross-gate offset noise guard
      saSplitMs = (uint32_t)(((uint32_t)d + 500) / 1000);
      saState = SA_RESULT;
      saShownMs = millis();
    }                                             // same source mid-run: ignored
  }
}
void saService(unsigned long now) {
  bool peer   = (peerLastHeardMs != 0) && ((now - peerLastHeardMs) < PEER_TIMEOUT_MS);
  bool synced = timeSynced;
  // Pre-run states track peer/sync: NO_GATE (go check the 2nd gate) vs SYNCING
  // (wait) vs READY. A lone gate can't split, so READY needs a peer, not just sync.
  if (saState == SA_NO_GATE || saState == SA_SYNCING || saState == SA_READY) {
    saState = !peer ? SA_NO_GATE : (!synced ? SA_SYNCING : SA_READY);
  } else if (saState == SA_ARMED && (!peer || !synced)) {
    saState = !peer ? SA_NO_GATE : SA_SYNCING;    // lost readiness before the start
  } else if (saState == SA_RUNNING) {
    if ((long)(now - saTimeoutAtMs) >= 0) { saState = SA_TIMEOUT; saShownMs = now; }
  } else if (saState == SA_TIMEOUT) {
    if ((long)(now - saShownMs) >= 2000) saState = SA_READY;   // re-evaluated next pass
  }
}
void saRender() {
  // redraw key: state + (running: 0.1s bucket) so the OLED isn't thrashed
  char key[24];
  switch (saState) {
    case SA_NO_GATE: strcpy(key, "nogate"); break;
    case SA_SYNCING: strcpy(key, "sync"); break;
    case SA_READY:   strcpy(key, "ready"); break;
    case SA_ARMED:   strcpy(key, "armed"); break;
    case SA_TIMEOUT: strcpy(key, "tmo"); break;
    case SA_RESULT:  snprintf(key, sizeof(key), "res%lu", (unsigned long)saSplitMs); break;
    case SA_RUNNING: {
      int32_t d = sdiff32(sharedMicros(), saStartUs); if (d < 0) d = 0;
      snprintf(key, sizeof(key), "run%lu", (unsigned long)((uint32_t)d / 100000));
      break;
    }
    default: strcpy(key, "?"); break;
  }
  if (strcmp(key, lastRender) == 0) return;
  strncpy(lastRender, key, sizeof(lastRender) - 1);
  lastRender[sizeof(lastRender) - 1] = '\0';

  u8g2.clearBuffer();
  u8g2.setFont(u8g2_font_ncenB08_tr);
  char big[16];
  switch (saState) {
    case SA_NO_GATE:
      u8g2.drawStr(0, 10, "STANDALONE");
      u8g2.setFont(u8g2_font_ncenB14_tr);
      u8g2.drawStr(0, 34, "NO GATE");
      u8g2.setFont(u8g2_font_ncenB08_tr);
      u8g2.drawStr(0, 54, "check 2nd gate");
      break;
    case SA_SYNCING:
      u8g2.drawStr(0, 10, "STANDALONE");
      u8g2.setFont(u8g2_font_ncenB18_tr);
      u8g2.drawStr(0, 40, "SYNCING");
      break;
    case SA_READY:
      u8g2.drawStr(0, 10, "STANDALONE");
      u8g2.setFont(u8g2_font_ncenB18_tr);
      u8g2.drawStr(0, 38, "READY");
      u8g2.setFont(u8g2_font_ncenB08_tr);
      u8g2.drawStr(0, 56, "B1 = arm");
      break;
    case SA_ARMED:
      u8g2.drawStr(0, 10, "ARMED");
      u8g2.setFont(u8g2_font_ncenB18_tr);
      u8g2.drawStr(0, 40, "GO!");
      u8g2.setFont(u8g2_font_ncenB08_tr);
      u8g2.drawStr(0, 58, "run through a gate");
      break;
    case SA_RUNNING: {
      int32_t d = sdiff32(sharedMicros(), saStartUs); if (d < 0) d = 0;
      snprintf(big, sizeof(big), "%.2fs", ((uint32_t)d) / 1000000.0);
      u8g2.drawStr(0, 10, "RUNNING");
      u8g2.setFont(u8g2_font_ncenB24_tr);
      u8g2.drawStr(2, 50, big);
      break;
    }
    case SA_RESULT:
      snprintf(big, sizeof(big), "%.3fs", saSplitMs / 1000.0);
      u8g2.drawStr(0, 10, "SPLIT");
      u8g2.setFont(u8g2_font_ncenB24_tr);
      u8g2.drawStr(2, 44, big);
      u8g2.setFont(u8g2_font_ncenB08_tr);
      u8g2.drawStr(0, 60, "B1 = again");
      break;
    case SA_TIMEOUT:
      u8g2.drawStr(0, 10, "STANDALONE");
      u8g2.setFont(u8g2_font_ncenB24_tr);
      u8g2.drawStr(20, 44, "-- --");
      u8g2.setFont(u8g2_font_ncenB08_tr);
      u8g2.drawStr(0, 60, "no finish");
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
  Serial.println(">>> conn-param request sent: 15ms interval (deferred)");
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
  if (has_display) {
    u8g2.begin();
    u8g2.clearBuffer();
    u8g2.setFont(u8g2_font_ncenB14_tr);
    u8g2.drawStr(5, 35, "EqualSplit");
    u8g2.sendBuffer();
    delay(1200);
  }

  setLunaFrameRate(250);

  pinMode(BUTTON1_PIN, INPUT_PULLUP);
  pinMode(BUTTON2_PIN, INPUT_PULLUP);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);

  // Params: load persisted overrides; a held B1 at boot restores defaults (the
  // non-BLE recovery path for a phone-less unit, §8.1).
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

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);                                         // radio awake for ESP-NOW RX (§15)
  esp_wifi_set_channel(ESPNOW_CHANNEL, WIFI_SECOND_CHAN_NONE);  // pin the shared channel

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
  bpeer.channel = ESPNOW_CHANNEL;
  bpeer.encrypt = false;
  if (esp_now_add_peer(&bpeer) != ESP_OK) Serial.println("Failed to add broadcast peer");

  setupBLE();                                                   // after ESP-NOW (coex, §10)
  WiFi.setSleep(false);                                         // re-assert: BLE coex can re-enable PS
  esp_wifi_set_channel(ESPNOW_CHANNEL, WIFI_SECOND_CHAN_NONE);

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
