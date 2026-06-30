#include <WiFi.h>
#include <esp_now.h>

// ========== HARDWARE ==========
#define LUNA_RX 16
#define LUNA_TX 17
const int GATE_THRESHOLD = 100;
int16_t distance;

uint8_t gate1MAC[] = {0xF4, 0x2D, 0xC9, 0x6A, 0xA0, 0x50};

// All timing fields are in MICROSECONDS, matching Gate 1.
struct GateData {
  int gateNumber;
  unsigned long timestampUs;  // Gate 1 trigger time (micros, Gate 1 clock) - informational
  unsigned long deltaUs;      // Gate 2: us from packet-receipt to its own trigger
  int mode;
  bool isResult;
};

int currentMode = 0;
volatile unsigned long packetRecvUs = 0;   // micros when Gate 1's packet arrived
volatile bool waitingForGate2 = false;
volatile int pendingMode = 0;
volatile bool newPacket = false;

bool lastGate2State = false;
unsigned long gate2DebounceUs = 0;
const unsigned long SENSOR_DEBOUNCE_US = 15000;  // 15 ms

unsigned long lastActivityMs = 0;
const unsigned long ACTIVITY_TIMEOUT = 30000;    // ms

unsigned long gate2EnableUs = 0;
const unsigned long GATE2_DELAY_US = 100000;     // 100 ms lockout after packet

// ============================================================================
// ===== v2 RAW-EVENT LAYER (write-once gate) — see docs/BLE-CONTRACT.md   =====
// Added ALONGSIDE the legacy timing path above. This gate is a broadcast
// participant: it has no BLE, so it cannot be the bridge. It broadcasts its own
// raw beam edges (+ buzzer/button events later), participates in gate-network
// time sync as a FOLLOWER, and answers re-broadcast commands targeting it.
// The legacy ESP-NOW result path (handleGate2Trigger) is untouched.
// ============================================================================
#define V2_FW_VER 2

// Event frame types (0x01-0x0F)
#define V2_BEAM_BREAK    0x01
#define V2_BEAM_CLEAR    0x02
#define V2_BUZZER_FIRED  0x03
#define V2_BUTTON_PRESS  0x04
// Link / discovery (0x20-0x2F)
#define V2_HEARTBEAT     0x20
#define V2_TIME_SYNC     0x21
// Commands (0x30-0x3F)
#define V2_ASSIGN_IDS    0x30
#define V2_SET_THRESHOLD 0x31
#define V2_BUZZER_FIRE   0x32
#define V2_CLEAR_QUEUE   0x33
#define V2_PING          0x34
#define V2_GET_STATUS    0x35
// Replies (0x40-0x4F)
#define V2_PING_REPLY    0x40
#define V2_STATUS_REPLY  0x41
// TIME_SYNC subtypes — firmware-internal payload (type 0x21 is frozen, payload is not)
#define TS_PING 0x01
#define TS_PONG 0x02

#define GATE_ID_ALL 0xFF
#define BUZZER_PIN  25            // declared now, wired at PCB respin (contract §15)

uint8_t bcastMAC[] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
uint8_t myMac[6]   = {0};

uint8_t  v2GateId    = 0;                 // 0 = unassigned until ASSIGN_IDS
uint16_t thresholdCm = GATE_THRESHOLD;    // runtime; default == legacy const

// Shared gate-network clock (follower): shared = local micros() + clkOffset.
volatile int32_t clkOffset = 0;
volatile bool    timeSynced = false;
uint32_t tsMinRtt    = 0xFFFFFFFFUL;      // best round-trip seen this window
uint32_t tsSeq       = 0;                 // our outstanding ping id
unsigned long lastTsPingMs   = 0;
unsigned long lastTsResetMs  = 0;
unsigned long lastHeartbeatMs = 0;

// v2 beam edge detector (independent debounce from the legacy detector)
bool v2LastBeam = false;
unsigned long v2DebounceUs = 0;

// buzzer (unwired; we still drive the pin and emit BUZZER_FIRED)
bool buzzerOn = false;
unsigned long buzzerOffMs = 0;

// inbound v2 frames staged from the ESP-NOW recv callback, drained in loop()
#define V2_RX_SLOTS 8
uint8_t v2Rx[V2_RX_SLOTS][32];
uint8_t v2RxLen[V2_RX_SLOTS];
volatile uint8_t v2RxHead = 0, v2RxTail = 0;

static inline uint32_t rd32(const uint8_t* p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static inline void wr32(uint8_t* p, uint32_t v) {
  p[0] = v & 0xFF; p[1] = (v >> 8) & 0xFF; p[2] = (v >> 16) & 0xFF; p[3] = (v >> 24) & 0xFF;
}
// Local micros mapped into the shared gate-network clock. uint32 wraparound add
// is correct for a negative offset (two's complement); the APP does sdiff32.
static inline uint32_t sharedMicros() { return (uint32_t)micros() + (uint32_t)clkOffset; }

// Broadcast a 7-byte raw event (BEAM_BREAK/CLEAR/BUZZER_FIRED/BUTTON_PRESS).
void v2EmitEvent(uint8_t type, uint32_t sharedUs, uint8_t flags) {
  uint8_t f[7];
  f[0] = type; f[1] = v2GateId; wr32(&f[2], sharedUs); f[6] = flags;
  esp_now_send(bcastMAC, f, 7);
}

// Always-on beam edge detector — emits BOTH edges, mode-free (contract §7).
void v2BeamDetect(int16_t dist, unsigned long nowUs) {
  bool beam = (dist > 0 && dist <= (int)thresholdCm);
  if (beam != v2LastBeam && (nowUs - v2DebounceUs) > SENSOR_DEBOUNCE_US) {
    v2DebounceUs = nowUs;
    v2LastBeam = beam;
    v2EmitEvent(beam ? V2_BEAM_BREAK : V2_BEAM_CLEAR, sharedMicros(), 0);
  }
}

void v2FireBuzzer(uint16_t durMs) {
  digitalWrite(BUZZER_PIN, HIGH);
  buzzerOn = true;
  buzzerOffMs = millis() + durMs;
  v2EmitEvent(V2_BUZZER_FIRED, sharedMicros(), 0);   // GO reference, stamped at fire instant
}

void v2ServiceBuzzer(unsigned long nowMs) {
  if (buzzerOn && (long)(nowMs - buzzerOffMs) >= 0) {
    digitalWrite(BUZZER_PIN, LOW);
    buzzerOn = false;
  }
}

// FOLLOWER time sync: ping the network, refine the offset off the min-RTT
// reply (PTP-lite). Kept deliberately modest — sub-ms when the link is quiet.
void v2ServiceTimeSync(unsigned long nowMs) {
  // Periodically forget the best sample so the offset re-acquires against
  // crystal drift (a few ms/min between two ESP32s).
  if ((long)(nowMs - lastTsResetMs) >= 10000) { lastTsResetMs = nowMs; tsMinRtt = 0xFFFFFFFFUL; }
  if ((long)(nowMs - lastTsPingMs) < 500) return;
  lastTsPingMs = nowMs;
  tsSeq++;
  uint8_t f[14];
  f[0] = V2_TIME_SYNC; f[1] = TS_PING;
  wr32(&f[2], tsSeq); wr32(&f[6], (uint32_t)micros()); wr32(&f[10], 0);
  esp_now_send(bcastMAC, f, 14);
}

void v2ApplyPong(const uint8_t* f) {
  // f: [0]=0x21 [1]=TS_PONG [2..5]=seq [6..9]=t1(our local) [10..13]=t2(master local)
  uint32_t seq = rd32(&f[2]);
  if (seq != tsSeq) return;                 // not our outstanding ping
  uint32_t t1 = rd32(&f[6]);
  uint32_t t2 = rd32(&f[10]);
  uint32_t t4 = (uint32_t)micros();
  uint32_t rtt = (uint32_t)(t4 - t1);
  if (rtt > 50000UL) return;                // >50 ms round trip: junk
  if (rtt < tsMinRtt) {
    tsMinRtt = rtt;
    uint32_t midpoint = t1 + rtt / 2;       // our-local instant matching master's t2
    clkOffset = (int32_t)(t2 - midpoint);   // shared(=master) = local + offset
    timeSynced = true;
  }
}

void v2ServiceHeartbeat(unsigned long nowMs) {
  unsigned long iv = (v2GateId == 0) ? 1000UL : 5000UL;
  if ((long)(nowMs - lastHeartbeatMs) < (long)iv) return;
  lastHeartbeatMs = nowMs;
  uint8_t f[7];
  f[0] = V2_HEARTBEAT; memcpy(&f[1], myMac, 6);
  esp_now_send(bcastMAC, f, 7);
}

void v2BroadcastStatus() {
  uint8_t f[8];
  f[0] = V2_STATUS_REPLY; f[1] = v2GateId;
  f[2] = thresholdCm & 0xFF; f[3] = (thresholdCm >> 8) & 0xFF;
  f[4] = 0xFF;             // battery: not sensed
  f[5] = 0;               // queue_depth: this gate emits live, no queue
  f[6] = V2_FW_VER;
  uint8_t caps = 0;        // no display / no buttons / buzzer unwired on Gate 2
  if (timeSynced) caps |= 0x08;
  f[7] = caps;
  esp_now_send(bcastMAC, f, 8);
}

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

// Dispatch one inbound v2 frame (from the bridge or another gate).
void v2HandleFrame(const uint8_t* f, uint8_t len) {
  switch (f[0]) {
    case V2_TIME_SYNC:
      if (len >= 14 && f[1] == TS_PONG) v2ApplyPong(f);
      break;
    case V2_ASSIGN_IDS:
      v2DoAssignIds(f, len);
      break;
    case V2_SET_THRESHOLD:
      if (len >= 4) { uint8_t tgt = f[1]; if (tgt == v2GateId || tgt == GATE_ID_ALL) thresholdCm = f[2] | (f[3] << 8); }
      break;
    case V2_BUZZER_FIRE:
      if (len >= 5) { uint8_t tgt = f[1]; if (tgt == v2GateId || tgt == GATE_ID_ALL) v2FireBuzzer(f[2] | (f[3] << 8)); }
      break;
    case V2_CLEAR_QUEUE:
      break;                 // no queue on this gate (it emits live)
    case V2_GET_STATUS:
      if (len >= 2) { uint8_t tgt = f[1]; if (tgt == v2GateId || tgt == GATE_ID_ALL) v2BroadcastStatus(); }
      break;
    default:
      break;                 // ignore other gates' events / heartbeats / our own pings
  }
}

void v2StageInbound(const uint8_t* d, int len) {
  if (len < 1 || len > 32) return;
  uint8_t nh = (v2RxHead + 1) % V2_RX_SLOTS;
  if (nh == v2RxTail) return;            // full: drop (sync/cmds are repeated)
  memcpy(v2Rx[v2RxHead], d, len);
  v2RxLen[v2RxHead] = (uint8_t)len;
  v2RxHead = nh;
}

void v2ProcessInbound() {
  while (v2RxTail != v2RxHead) {
    v2HandleFrame(v2Rx[v2RxTail], v2RxLen[v2RxTail]);
    v2RxTail = (v2RxTail + 1) % V2_RX_SLOTS;
  }
}
// ===== end v2 raw-event layer ===============================================

// ========== LUNA UART ==========
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
        Serial2.read();  // consume second 0x59
        uint8_t buf[7];
        if (Serial2.readBytes(buf, 7) != 7) return false;
        uint8_t checksum = 0x59 + 0x59;
        for (int i = 0; i < 6; i++) checksum += buf[i];
        if (checksum == buf[6]) {
          dist = buf[0] | (buf[1] << 8);
          return true;
        }
      }
    }
  }
  return false;
}

void flushLuna() {
  while (Serial2.available()) Serial2.read();
  lastGate2State = false;
}

// ========== ESP-NOW CALLBACKS ==========
void onDataSent(const wifi_tx_info_t *info, esp_now_send_status_t status) {
  Serial.println(status == ESP_NOW_SEND_SUCCESS ? "Send OK" : "Send FAILED");
}

void onDataRecv(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  if (len == (int)sizeof(GateData)) {          // ----- legacy trigger packet (unchanged) -----
    GateData received;
    memcpy(&received, data, sizeof(received));
    if (!received.isResult && received.gateNumber == 1) {
      packetRecvUs = micros();   // stamp arrival immediately, in ISR context
      pendingMode = received.mode;
      newPacket = true;
    }
    return;
  }
  v2StageInbound(data, len);                    // ----- v2 frame from the bridge/another gate -----
}

// ========== FORWARD DECLARATION ==========
void handleGate2Trigger(unsigned long nowUs);
void legacyGate2Detect(int16_t dist, unsigned long nowUs);

// ========== SETUP ==========
void setup() {
  Serial.begin(115200);
  Serial2.begin(115200, SERIAL_8N1, LUNA_RX, LUNA_TX);
  delay(500);  // let the Luna boot before sending config

  setLunaFrameRate(250);

  WiFi.mode(WIFI_STA);
  WiFi.macAddress(myMac);
  Serial.print("Gate 2 MAC: ");
  Serial.println(WiFi.macAddress());

  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);

  if (esp_now_init() != ESP_OK) {
    Serial.println("ESP-NOW init FAILED");
    return;
  }

  esp_now_register_send_cb(onDataSent);
  esp_now_register_recv_cb(onDataRecv);

  esp_now_peer_info_t peerInfo = {};
  memcpy(peerInfo.peer_addr, gate1MAC, 6);
  peerInfo.channel = 0;
  peerInfo.encrypt = false;

  if (esp_now_add_peer(&peerInfo) != ESP_OK) {
    Serial.println("Failed to add Gate 1 peer");
  } else {
    Serial.println("Gate 1 peer added OK");
  }

  // v2: broadcast peer (FF:FF:FF:FF:FF:FF) for the raw-event layer
  esp_now_peer_info_t bpeer = {};
  memcpy(bpeer.peer_addr, bcastMAC, 6);
  bpeer.channel = 0;
  bpeer.encrypt = false;
  if (esp_now_add_peer(&bpeer) != ESP_OK) Serial.println("Failed to add broadcast peer");

  Serial.println("Gate 2 ready - waiting for Gate 1 signal...");
}

// ========== MAIN LOOP ==========
void loop() {
  unsigned long nowMs = millis();

  // ===== v2 services (run every pass, mode-free) =====
  v2ProcessInbound();
  v2ServiceTimeSync(nowMs);
  v2ServiceHeartbeat(nowMs);
  v2ServiceBuzzer(nowMs);

  // ----- legacy: pick up a newly-received trigger packet (set in ISR) -----
  if (newPacket) {
    newPacket = false;
    currentMode = pendingMode;
    waitingForGate2 = true;
    lastActivityMs = millis();
    gate2EnableUs = packetRecvUs + GATE2_DELAY_US;
    flushLuna();  // clear stale frames so we react to a fresh crossing
    Serial.printf("Gate 1 signal received - mode %d\n", currentMode);
  }

  if (waitingForGate2 && (millis() - lastActivityMs) > ACTIVITY_TIMEOUT) {
    Serial.println("Timeout - resetting");
    waitingForGate2 = false;
    currentMode = 0;
  }

  // ===== unified LiDAR poll — one read feeds BOTH pipelines =====
  // v2 emits BEAM_BREAK/CLEAR on every edge (mode-free). The proven legacy
  // detector runs only while armed and past the post-packet lockout, with its
  // OWN debounce state — its logic is unchanged, only its read source moved
  // here so the two pipelines never fight over the UART.
  while (readLuna(distance)) {
    unsigned long nowUs = micros();
    v2BeamDetect(distance, nowUs);                          // v2: always
    if (waitingForGate2 && nowUs >= gate2EnableUs)          // legacy: armed only
      legacyGate2Detect(distance, nowUs);
  }
}

// ========== LEGACY GATE 2 DETECTION ==========
// Body lifted verbatim from the old loop() sensor block; only the readLuna()
// and lockout gating moved up into the unified poll. Timing logic unchanged.
void legacyGate2Detect(int16_t dist, unsigned long nowUs) {
  bool triggered = (dist > 0 && dist <= GATE_THRESHOLD);
  if (triggered && !lastGate2State) {
    if ((nowUs - gate2DebounceUs) > SENSOR_DEBOUNCE_US) {
      gate2DebounceUs = nowUs;
      lastGate2State = true;
      handleGate2Trigger(nowUs);
    }
  } else if (!triggered) {
    lastGate2State = false;
  }
}

// ========== HANDLE GATE 2 TRIGGER ==========
void handleGate2Trigger(unsigned long nowUs) {
  Serial.println("!!! GATE 2 TRIGGERED !!!");

  // Delta = us from when Gate 2 received Gate 1's packet to its own trigger.
  // Gate 1 adds half the measured network round-trip to recover the lost
  // one-way transit time, so this delta does NOT need to include it.
  unsigned long deltaUs = nowUs - packetRecvUs;

  GateData result = {};
  result.gateNumber = 2;
  result.isResult = true;
  result.mode = currentMode;
  result.deltaUs = deltaUs;

  Serial.printf("Gate 2 delta: %lu us\n", deltaUs);

  esp_now_send(gate1MAC, (uint8_t *)&result, sizeof(result));
  Serial.println("Result sent to Gate 1");

  waitingForGate2 = false;
  currentMode = 0;
}
