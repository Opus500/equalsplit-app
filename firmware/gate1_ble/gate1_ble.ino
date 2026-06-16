#include <Wire.h>
#include <U8g2lib.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_random.h>    // hardware TRNG for the Mode 2 random GO delay
#include <NimBLEDevice.h>   // Install "NimBLE-Arduino" via Library Manager

// ========== BLE CONTRACT v1 ==========
#define PROTO_VER 1

// Base UUID 7E5D00xx-9A1B-4C2D-8E3F-1A2B3C4D5E6F (vary first group only)
#define UUID_SERVICE     "7E5D0001-9A1B-4C2D-8E3F-1A2B3C4D5E6F"
#define UUID_COMMAND     "7E5D0002-9A1B-4C2D-8E3F-1A2B3C4D5E6F"
#define UUID_EVENT       "7E5D0003-9A1B-4C2D-8E3F-1A2B3C4D5E6F"
#define UUID_LASTRESULT  "7E5D0004-9A1B-4C2D-8E3F-1A2B3C4D5E6F"
#define UUID_STATUS      "7E5D0005-9A1B-4C2D-8E3F-1A2B3C4D5E6F"

// Command opcodes (phone -> gate)
#define CMD_ARM_MODE1       0x01
#define CMD_ARM_MODE2       0x02
#define CMD_START_SEQUENCE  0x03
#define CMD_RESET           0x04
#define CMD_GO_NOW          0x05
#define CMD_PING            0x06

// Event types (gate -> phone)
#define EVT_STATE     0x10
#define EVT_COUNTDOWN 0x11
#define EVT_GO        0x12
#define EVT_START     0x13
#define EVT_SPLIT     0x14
#define EVT_FINISH    0x15
#define EVT_NOTICE    0x1E

// Wire-state enum (contract §6) — distinct from SystemMode ordering
#define WSTATE_IDLE        0
#define WSTATE_RESULT      1
#define WSTATE_M1_ARMED    2
#define WSTATE_M1_RUNNING  3
#define WSTATE_M2_ARMED    4
#define WSTATE_M2_TO_GATE1 5
#define WSTATE_M2_TO_GATE2 6
#define WSTATE_M2_COUNTDOWN 7

// NOTICE codes (contract §8)
#define NOTICE_TIMEOUT       1
#define NOTICE_SEND_FAILED   2
#define NOTICE_DOUBLE_TRIG   3
#define NOTICE_CMD_REJECTED  4

// BLE globals
NimBLECharacteristic* chEvent     = nullptr;
NimBLECharacteristic* chLastResult = nullptr;
NimBLECharacteristic* chStatus    = nullptr;
volatile bool bleConnected = false;
uint8_t evtSeq = 0;

// Deferred connection-parameter request. Requesting a tight interval inside
// onConnect previously broke the iOS link, so we DEFER it: schedule on connect,
// then fire ONCE from loop() a few seconds later, after the link has settled.
// updateConnParams only *requests* — if the central declines, the link simply
// keeps its current params (it does not drop), so this is safe to fail.
volatile bool connParamPending = false;
uint16_t pendingConnHandle = 0;
unsigned long connParamDueMs = 0;
const unsigned long CONN_PARAM_DELAY_MS = 3000;  // let the connection settle first

// Command handoff from BLE task -> loop() (see note on task safety)
volatile uint8_t pendingCmd = 0;
volatile uint8_t pendingArg0 = 0;
volatile uint8_t pendingArg1 = 0;

// ESP-NOW finish-link health, surfaced in Status
volatile bool finishLinkOk = true;

// ========== HARDWARE ==========
#define LUNA_RX 16
#define LUNA_TX 17
const int GATE_THRESHOLD = 100;
int16_t distance;

const int BUTTON1_PIN = 15;
const int BUTTON2_PIN = 4;

U8G2_SH1106_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);

// ========== SESSION HISTORY ==========
#define MAX_RUNS 50
struct RunRecord {
  int mode;
  unsigned long totalMs;
  unsigned long split1Ms;
  unsigned long split2Ms;
};
RunRecord sessionRuns[MAX_RUNS];
int runCount = 0;

// ========== ESP-NOW ==========
uint8_t gate2MAC[] = {0xF4, 0x2D, 0xC9, 0x6B, 0xF7, 0x3C};

// All timing fields are in MICROSECONDS for precision.
struct GateData {
  int gateNumber;
  unsigned long timestampUs;  // Gate 1 trigger time (micros, Gate 1 clock) - informational
  unsigned long deltaUs;      // Gate 2: us from packet-receipt to its own trigger
  int mode;
  bool isResult;
};

// ========== STATE ==========
enum SystemMode {
  MODE_IDLE,
  MODE_SHOWING_RESULT,
  MODE_1_ACTIVATED,
  MODE_1_WAITING_GATE2,
  MODE_2_ACTIVATED,
  MODE_2_WAITING_GATE1,
  MODE_2_WAITING_GATE2,
  MODE_2_PHONE_ARMED,   // phone-armed (non-blocking), waiting for START_SEQUENCE
  MODE_2_COUNTDOWN      // phone-driven on-marks/set/GO, non-blocking
};
SystemMode currentMode = MODE_IDLE;

// Timing reference points (microseconds, Gate 1 clock)
unsigned long startTimeUs = 0;         // Mode 2 "GO" instant
unsigned long gate1TriggerUs = 0;      // when Gate 1 beam broke
unsigned long firstSplitUs = 0;        // Mode 2 split 1 (GO -> Gate 1)
unsigned long packetSentUs = 0;        // when we sent the trigger packet to Gate 2

bool gate1Triggered = false;
bool lastGate1State = false;
unsigned long gate1DebounceUs = 0;
const unsigned long SENSOR_DEBOUNCE_US = 15000;  // 15 ms

unsigned long lastButton1Press = 0;
unsigned long lastButton2Press = 0;
const unsigned long DEBOUNCE_DELAY = 200;  // ms (button UI debounce)

unsigned long modeTimeout = 0;             // ms
const unsigned long MODE_TIMEOUT = 30000;  // ms

volatile bool resultReady = false;
GateData lastResult;
volatile unsigned long resultRecvUs = 0;   // micros when result packet arrived

unsigned long lastDisplayUpdate = 0;       // ms
const unsigned long DISPLAY_INTERVAL = 100;

unsigned long idleLockoutUntil = 0;        // ms

char lastTimerStr[16] = "";

// ===== PHONE-INITIATED MODE 2 (non-blocking countdown) =====
// Sequence: marks (phase 1) -> [CD_MARKS_MS] -> set (phase 2) -> [CD_SET_MS]
//        -> go-imminent (phase 3) -> [random hold] -> GO.
// The random hold is the LAST segment before GO, with no cue inside it, so the
// athlete cannot anticipate the start. All timing is millis()-based in loop().
const unsigned long CD_MARKS_MS = 1500;          // "on your marks" hold
const unsigned long CD_SET_MS   = 1000;          // "set" hold before the random window
const unsigned long CD_HOLD_MIN_DEFAULT = 2000;  // default random window when args are 0,0
const unsigned long CD_HOLD_MAX_DEFAULT = 5000;
unsigned long cdSetAtMs = 0;                      // when to emit phase 2 (set)
unsigned long cdGoImminentAtMs = 0;              // when to emit phase 3 (go-imminent)
unsigned long cdGoAtMs = 0;                      // when GO fires
uint8_t cdPhase = 0;                             // highest COUNTDOWN phase emitted (0=none)

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

// Drain stale UART + reset edge detection so arming never false-triggers.
void flushLunaBuffer() {
  while (Serial2.available()) Serial2.read();
  lastGate1State = false;
  gate1Triggered = false;
  int discarded = 0;
  unsigned long t = millis();
  while (discarded < 5 && millis() - t < 50) {
    int16_t tmp;
    if (readLuna(tmp)) discarded++;
  }
}

// ========== ESP-NOW CALLBACKS ==========
void onDataSent(const wifi_tx_info_t *info, esp_now_send_status_t status) {
  finishLinkOk = (status == ESP_NOW_SEND_SUCCESS);
  Serial.println(finishLinkOk ? "Send OK" : "Send FAILED");
}

void onDataRecv(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  if (len != sizeof(GateData)) return;       // ignore malformed packets
  GateData received;
  memcpy(&received, data, sizeof(received));
  if (!received.isResult) return;
  resultRecvUs = micros();                   // stamp arrival immediately
  lastResult = received;
  resultReady = true;
}

// ========== BLE: STATE MAPPING & EMITTERS ==========
uint8_t wireState() {
  switch (currentMode) {
    case MODE_IDLE:            return WSTATE_IDLE;
    case MODE_SHOWING_RESULT:  return WSTATE_RESULT;
    case MODE_1_ACTIVATED:     return WSTATE_M1_ARMED;
    case MODE_1_WAITING_GATE2: return WSTATE_M1_RUNNING;
    case MODE_2_ACTIVATED:     return WSTATE_M2_ARMED;
    case MODE_2_WAITING_GATE1: return WSTATE_M2_TO_GATE1;
    case MODE_2_WAITING_GATE2: return WSTATE_M2_TO_GATE2;
    case MODE_2_PHONE_ARMED:   return WSTATE_M2_ARMED;
    case MODE_2_COUNTDOWN:     return WSTATE_M2_COUNTDOWN;
    default:                   return WSTATE_IDLE;
  }
}

uint8_t currentModeNum() {
  if (currentMode == MODE_1_ACTIVATED || currentMode == MODE_1_WAITING_GATE2) return 1;
  if (currentMode == MODE_2_ACTIVATED || currentMode == MODE_2_WAITING_GATE1 ||
      currentMode == MODE_2_WAITING_GATE2 || currentMode == MODE_2_PHONE_ARMED ||
      currentMode == MODE_2_COUNTDOWN) return 2;
  return 0;
}

void putU32(uint8_t* b, uint32_t v) {  // little-endian
  b[0] = v & 0xFF; b[1] = (v >> 8) & 0xFF; b[2] = (v >> 16) & 0xFF; b[3] = (v >> 24) & 0xFF;
}

void notifyEvent(const uint8_t* payload, size_t plen) {
  if (!chEvent || !bleConnected) return;
  chEvent->setValue(payload, plen);
  chEvent->notify();
}

void emitState() {
  uint8_t p[4] = { EVT_STATE, evtSeq++, wireState(), currentModeNum() };
  notifyEvent(p, 4);
}

void emitNotice(uint8_t code) {
  uint8_t p[3] = { EVT_NOTICE, evtSeq++, code };
  notifyEvent(p, 3);
}

void emitCountdown(uint8_t phase) {  // Mode 2 phone sequence: 1=marks, 2=set, 3=go-imminent
  uint8_t p[3] = { EVT_COUNTDOWN, evtSeq++, phase };
  notifyEvent(p, 3);
}

void emitStart(uint8_t mode, uint32_t t0us) {  // Mode 1 clock start
  uint8_t p[7]; p[0] = EVT_START; p[1] = evtSeq++; p[2] = mode; putU32(&p[3], t0us);
  notifyEvent(p, 7);
}

void emitGo(uint8_t mode, uint32_t t0us) {     // Mode 2 GO instant
  uint8_t p[7]; p[0] = EVT_GO; p[1] = evtSeq++; p[2] = mode; putU32(&p[3], t0us);
  notifyEvent(p, 7);
}

void emitSplit(uint8_t mode, uint8_t index, uint32_t splitMs) {
  uint8_t p[8]; p[0] = EVT_SPLIT; p[1] = evtSeq++; p[2] = mode; p[3] = index;
  putU32(&p[4], splitMs);
  notifyEvent(p, 8);
}

void emitFinish(uint8_t mode, uint32_t totalMs, uint32_t s1Ms, uint32_t s2Ms, uint8_t flags) {
  uint8_t p[16];
  p[0] = EVT_FINISH; p[1] = evtSeq++; p[2] = mode;
  putU32(&p[3], totalMs); putU32(&p[7], s1Ms); putU32(&p[11], s2Ms);
  p[15] = flags;
  notifyEvent(p, 16);
}

// LastResult (Read+Notify): 16 bytes — survives a dropped link
void updateLastResult(uint8_t mode, uint32_t totalMs, uint32_t s1Ms, uint32_t s2Ms,
                      uint8_t flags, uint8_t runIdx) {
  if (!chLastResult) return;
  uint8_t p[16];
  p[0] = mode; putU32(&p[1], totalMs); putU32(&p[5], s1Ms); putU32(&p[9], s2Ms);
  p[13] = flags; p[14] = runIdx; p[15] = 0;
  chLastResult->setValue(p, 16);
  if (bleConnected) chLastResult->notify();
}

// Status (Read+Notify): 9 bytes — app reads on connect to resync
void updateStatus() {
  if (!chStatus) return;
  uint8_t p[9];
  p[0] = PROTO_VER; p[1] = wireState(); p[2] = currentModeNum();
  p[3] = (uint8_t)runCount; p[4] = finishLinkOk ? 1 : 0;
  putU32(&p[5], (uint32_t)micros());
  chStatus->setValue(p, 9);
  if (bleConnected) chStatus->notify();
}

// ========== BLE CALLBACKS ==========
class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* s, NimBLEConnInfo& info) override {
    bleConnected = true;
    Serial.println("BLE central connected");
    // Do NOT request conn params here (it broke the iOS link). Schedule the
    // deferred request; serviceConnParam() fires it once from loop().
    pendingConnHandle = info.getConnHandle();
    connParamDueMs    = millis() + CONN_PARAM_DELAY_MS;
    connParamPending  = true;
  }
  void onDisconnect(NimBLEServer* s, NimBLEConnInfo& info, int reason) override {
    bleConnected = false;
    connParamPending = false;   // link gone before the request fired — cancel it
    Serial.println("BLE central disconnected — re-advertising");
    NimBLEDevice::startAdvertising();
  }
};

// IMPORTANT: this runs on the NimBLE task, NOT loop(). We only stash the
// command; loop() consumes it on its next pass. This avoids touching
// currentMode / starting a run from another task mid-transition.
class CommandCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* c, NimBLEConnInfo& info) override {
    std::string v = c->getValue();
    if (v.size() < 1) return;
    pendingArg0 = v.size() > 1 ? (uint8_t)v[1] : 0;
    pendingArg1 = v.size() > 2 ? (uint8_t)v[2] : 0;
    pendingCmd  = (uint8_t)v[0];   // set last so loop() sees args first
  }
};

// ========== HELPERS ==========
void drawIdleScreen() {
  u8g2.clearBuffer();
  u8g2.setFont(u8g2_font_ncenB08_tr);
  u8g2.drawStr(0, 10, "READY  B1=M1  B2=M2");
  u8g2.drawHLine(0, 13, 128);

  int y = 25;
  int shown = 0;
  for (int i = runCount - 1; i >= 0 && shown < 3; i--, shown++) {
    RunRecord& r = sessionRuns[i];
    char buf[40];
    if (r.mode == 1) {
      sprintf(buf, "%d: %.3fs  M1", i + 1, r.totalMs / 1000.0);
      u8g2.drawStr(0, y, buf);
      y += 13;
    } else {
      sprintf(buf, "%d: Tot:%.3fs M2", i + 1, r.totalMs / 1000.0);
      u8g2.drawStr(0, y, buf);
      y += 11;
      sprintf(buf, "   S1:%.2f S2:%.2f", r.split1Ms / 1000.0, r.split2Ms / 1000.0);
      u8g2.drawStr(0, y, buf);
      y += 11;
    }
  }

  if (runCount == 0) u8g2.drawStr(15, 38, "No runs yet.");
  u8g2.sendBuffer();
}

void drawLiveTimer(unsigned long elapsedMs, const char* label) {
  char buf[16];
  sprintf(buf, "%.1fs", elapsedMs / 1000.0);
  if (strcmp(buf, lastTimerStr) == 0) return;
  strcpy(lastTimerStr, buf);

  u8g2.clearBuffer();
  u8g2.setFont(u8g2_font_ncenB08_tr);
  u8g2.drawStr(0, 10, label);
  u8g2.setFont(u8g2_font_ncenB24_tr);
  u8g2.drawStr(5, 50, buf);
  u8g2.sendBuffer();
}

void drawCountdownScreen(const char* big) {
  u8g2.clearBuffer();
  u8g2.setFont(u8g2_font_ncenB08_tr);
  u8g2.drawStr(0, 10, "MODE 2");
  u8g2.setFont(u8g2_font_ncenB24_tr);
  u8g2.drawStr(20, 45, big);
  u8g2.sendBuffer();
}

void resetToIdle() {
  currentMode = MODE_IDLE;
  gate1Triggered = false;
  lastTimerStr[0] = '\0';
  idleLockoutUntil = millis() + 500;
  drawIdleScreen();
  Serial.println(">>> IDLE");
  emitState();
  updateStatus();
}

// ========== FORWARD DECLARATIONS ==========
void startMode1();
void startMode2();
void handleGate1Trigger(unsigned long nowUs);
void processResult(GateData& received);
bool readGate1();
void armMode2Phone();
void startSequencePhone(uint8_t minUnits, uint8_t maxUnits);
void serviceCountdown(unsigned long now);
void fireGoPhone();

// ========== BLE INIT ==========
// Called AFTER esp_now_init(). NimBLE and ESP-NOW share the 2.4GHz radio;
// this is the coexistence path the contract §10 says to validate on hardware.
void setupBLE() {
  NimBLEDevice::init("EqualSplit-G1");
  NimBLEDevice::setPower(ESP_PWR_LVL_P9);  // max TX; lower later if it disturbs ESP-NOW

  NimBLEServer* server = NimBLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());

  NimBLEService* svc = server->createService(UUID_SERVICE);

  NimBLECharacteristic* chCmd = svc->createCharacteristic(
      UUID_COMMAND, NIMBLE_PROPERTY::WRITE);
  chCmd->setCallbacks(new CommandCallbacks());

  chEvent = svc->createCharacteristic(
      UUID_EVENT, NIMBLE_PROPERTY::NOTIFY);

  chLastResult = svc->createCharacteristic(
      UUID_LASTRESULT, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);

  chStatus = svc->createCharacteristic(
      UUID_STATUS, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);

  svc->start();

  // Seed initial characteristic values so a fresh connect reads sane data
  updateStatus();
  updateLastResult(0, 0, 0, 0, 0, 0);

  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  adv->addServiceUUID(UUID_SERVICE);   // app scans by service UUID, not name
  adv->enableScanResponse(true);
  NimBLEDevice::startAdvertising();

  Serial.println("BLE advertising as EqualSplit-G1");
}

// Handle a command stashed by the BLE task. Runs in loop() context.
void handlePendingCommand() {
  if (pendingCmd == 0) return;
  uint8_t cmd = pendingCmd;
  pendingCmd = 0;  // consume

  switch (cmd) {
    case CMD_ARM_MODE1:
      if (currentMode == MODE_IDLE) startMode1();
      else emitNotice(NOTICE_CMD_REJECTED);
      break;

    case CMD_ARM_MODE2:
      // Phone path: NON-BLOCKING arm. The blocking button path (startMode2)
      // is untouched and still reachable via Button 2 from idle.
      if (currentMode == MODE_IDLE) armMode2Phone();
      else emitNotice(NOTICE_CMD_REJECTED);
      break;

    case CMD_RESET:
      resetToIdle();
      break;

    case CMD_START_SEQUENCE:
      // Run the random on-marks/set/GO sequence (args = min,max in 100ms units).
      if (currentMode == MODE_2_PHONE_ARMED) startSequencePhone(pendingArg0, pendingArg1);
      else emitNotice(NOTICE_CMD_REJECTED);
      break;

    case CMD_GO_NOW:
      // Immediate GO, skipping the random hold — handy for testing.
      if (currentMode == MODE_2_PHONE_ARMED || currentMode == MODE_2_COUNTDOWN) fireGoPhone();
      else emitNotice(NOTICE_CMD_REJECTED);
      break;

    case CMD_PING:
      Serial.println(">>> PING (clock sync)");  // diagnostic: confirms pings arrive
      updateStatus();  // refreshes gate_micros + notifies Status
      break;

    default:
      emitNotice(NOTICE_CMD_REJECTED);
      break;
  }
}

// Fire the deferred connection-interval request ONCE per connection, a few
// seconds after connect. min=max=12 units = 15 ms — the tightest interval Apple
// accepts (it explicitly allows Interval Min == Interval Max == 15 ms). A tighter
// interval shrinks the phone<->gate clock-sync error (eClk ~= RTT/2), pulling
// Mode 2 reaction accuracy from ~±25 ms toward ~±15 ms. Runs on the loop() task
// AFTER the link has settled, which avoids the drop seen when this was done in
// onConnect. If iOS declines 15 ms, the link keeps its current params (no drop);
// the fallback if it's rejected is a 12,24 (15–30 ms) range.
void serviceConnParam() {
  if (!connParamPending) return;
  if (!bleConnected) { connParamPending = false; return; }
  if ((long)(millis() - connParamDueMs) < 0) return;
  connParamPending = false;  // exactly once
  NimBLEServer* s = NimBLEDevice::getServer();
  if (!s) return;
  s->updateConnParams(pendingConnHandle, 12, 12, 0, 400);  // 15ms interval, 4s timeout
  Serial.println(">>> conn-param request sent: 15ms interval (deferred)");
}

// ========== SETUP ==========
void setup() {
  Serial.begin(115200);
  Serial2.begin(115200, SERIAL_8N1, LUNA_RX, LUNA_TX);

  Wire.begin(21, 22);
  Wire.setClock(400000);  // fast I2C so OLED writes are quick
  u8g2.begin();
  u8g2.clearBuffer();
  u8g2.setFont(u8g2_font_ncenB14_tr);
  u8g2.drawStr(5, 35, "EqualSplit");
  u8g2.sendBuffer();
  delay(1500);

  setLunaFrameRate(250);

  pinMode(BUTTON1_PIN, INPUT_PULLUP);
  pinMode(BUTTON2_PIN, INPUT_PULLUP);

  WiFi.mode(WIFI_STA);
  Serial.print("Gate 1 MAC: ");
  Serial.println(WiFi.macAddress());

  if (esp_now_init() != ESP_OK) {
    Serial.println("ESP-NOW init FAILED");
    u8g2.clearBuffer();
    u8g2.setFont(u8g2_font_ncenB10_tr);
    u8g2.drawStr(0, 20, "ESP-NOW");
    u8g2.drawStr(0, 40, "Error!");
    u8g2.sendBuffer();
    return;
  }

  esp_now_register_send_cb(onDataSent);
  esp_now_register_recv_cb(onDataRecv);

  esp_now_peer_info_t peerInfo = {};
  memcpy(peerInfo.peer_addr, gate2MAC, 6);
  peerInfo.channel = 0;
  peerInfo.encrypt = false;

  if (esp_now_add_peer(&peerInfo) != ESP_OK) {
    Serial.println("Failed to add Gate 2 peer");
  } else {
    Serial.println("Gate 2 peer added OK");
  }

  resetToIdle();

  setupBLE();   // after ESP-NOW; validate coexistence on hardware (contract §10)
}

// ========== MAIN LOOP ==========
void loop() {
  unsigned long now = millis();

  handlePendingCommand();   // consume any BLE command from the NimBLE task
  serviceConnParam();       // fire the deferred conn-interval request once, post-connect
  serviceCountdown(now);    // advance the non-blocking Mode 2 countdown, if running

  // Sensor read ALWAYS first
  if (currentMode == MODE_1_ACTIVATED || currentMode == MODE_2_WAITING_GATE1) {
    readGate1();
  } else {
    // Not armed: drain the buffer so it never sits in overflow
    while (Serial2.available()) Serial2.read();
  }

  if (resultReady) {
    resultReady = false;
    processResult(lastResult);
  }

  if (currentMode != MODE_IDLE && currentMode != MODE_SHOWING_RESULT &&
      currentMode != MODE_2_ACTIVATED && now > modeTimeout) {
    Serial.println("Timeout - resetting");
    emitNotice(NOTICE_TIMEOUT);
    resetToIdle();
    return;
  }

  // Live timer updates (display only; never gates the sensor)
  if (now - lastDisplayUpdate > DISPLAY_INTERVAL) {
    lastDisplayUpdate = now;
    unsigned long us = micros();
    if (currentMode == MODE_1_WAITING_GATE2) {
      drawLiveTimer((us - gate1TriggerUs) / 1000, "MODE 1 - RUNNING");
    } else if (currentMode == MODE_2_WAITING_GATE1) {
      drawLiveTimer((us - startTimeUs) / 1000, "MODE 2 - TO GATE 1");
    } else if (currentMode == MODE_2_WAITING_GATE2) {
      drawLiveTimer((us - startTimeUs) / 1000, "MODE 2 - TO GATE 2");
    }
  }

  // Button handling — blocked during lockout
  if (now < idleLockoutUntil) return;

  switch (currentMode) {
    case MODE_IDLE:
      if (digitalRead(BUTTON1_PIN) == LOW && (now - lastButton1Press) > DEBOUNCE_DELAY) {
        lastButton1Press = now;
        startMode1();
      }
      if (digitalRead(BUTTON2_PIN) == LOW && (now - lastButton2Press) > DEBOUNCE_DELAY) {
        lastButton2Press = now;
        startMode2();
      }
      break;

    case MODE_1_ACTIVATED:
    case MODE_1_WAITING_GATE2:
    case MODE_2_WAITING_GATE1:
    case MODE_2_WAITING_GATE2:
    case MODE_2_PHONE_ARMED:
    case MODE_2_COUNTDOWN:
      if (digitalRead(BUTTON1_PIN) == LOW && (now - lastButton1Press) > DEBOUNCE_DELAY) {
        lastButton1Press = now;
        Serial.println("Cancelled by Button 1");
        resetToIdle();
      }
      break;

    case MODE_SHOWING_RESULT:
      if ((digitalRead(BUTTON1_PIN) == LOW && (now - lastButton1Press) > DEBOUNCE_DELAY) ||
          (digitalRead(BUTTON2_PIN) == LOW && (now - lastButton2Press) > DEBOUNCE_DELAY)) {
        lastButton1Press = now;
        lastButton2Press = now;
        resetToIdle();
      }
      break;

    default:
      break;
  }
}

// ========== MODE 1 ==========
void startMode1() {
  currentMode = MODE_1_ACTIVATED;
  modeTimeout = millis() + MODE_TIMEOUT;

  u8g2.clearBuffer();
  u8g2.setFont(u8g2_font_ncenB08_tr);
  u8g2.drawStr(0, 10, "MODE 1");
  u8g2.setFont(u8g2_font_ncenB14_tr);
  u8g2.drawStr(5, 38, "ACTIVATED");
  u8g2.setFont(u8g2_font_ncenB08_tr);
  u8g2.drawStr(0, 56, "Run through Gate 1");
  u8g2.sendBuffer();

  flushLunaBuffer();  // clean baseline so we don't instantly trigger
  Serial.println(">>> MODE 1 ACTIVATED");
  emitState();
  updateStatus();
}

// ========== MODE 2 ==========
void startMode2() {
  currentMode = MODE_2_ACTIVATED;
  modeTimeout = millis() + MODE_TIMEOUT;

  u8g2.clearBuffer();
  u8g2.setFont(u8g2_font_ncenB08_tr);
  u8g2.drawStr(0, 10, "MODE 2");
  u8g2.setFont(u8g2_font_ncenB14_tr);
  u8g2.drawStr(5, 38, "ACTIVATED");
  u8g2.setFont(u8g2_font_ncenB08_tr);
  u8g2.drawStr(0, 56, "Hold Btn 2...");
  u8g2.sendBuffer();

  Serial.println(">>> MODE 2 ACTIVATED");
  emitState();
  updateStatus();

  unsigned long timeout = millis() + 10000;
  while (digitalRead(BUTTON2_PIN) == HIGH) {
    if (millis() > timeout) { resetToIdle(); return; }
    yield();
  }

  u8g2.clearBuffer();
  u8g2.setFont(u8g2_font_ncenB08_tr);
  u8g2.drawStr(0, 10, "MODE 2");
  u8g2.setFont(u8g2_font_ncenB18_tr);
  u8g2.drawStr(0, 35, "RELEASE");
  u8g2.setFont(u8g2_font_ncenB10_tr);
  u8g2.drawStr(0, 52, "TO START");
  u8g2.sendBuffer();

  timeout = millis() + 10000;
  while (digitalRead(BUTTON2_PIN) == LOW) {
    if (millis() > timeout) { resetToIdle(); return; }
    yield();
  }

  flushLunaBuffer();          // clean baseline BEFORE the clock starts
  startTimeUs = micros();
  currentMode = MODE_2_WAITING_GATE1;
  modeTimeout = millis() + MODE_TIMEOUT;

  u8g2.clearBuffer();
  u8g2.setFont(u8g2_font_ncenB08_tr);
  u8g2.drawStr(0, 10, "MODE 2");
  u8g2.setFont(u8g2_font_ncenB24_tr);
  u8g2.drawStr(30, 45, "GO!");
  u8g2.setFont(u8g2_font_ncenB08_tr);
  u8g2.drawStr(0, 60, "Run to Gate 1");
  u8g2.sendBuffer();

  Serial.printf(">>> MODE 2 GO @ %lu us\n", startTimeUs);
  emitState();                    // now M2_TO_GATE1
  emitGo(2, (uint32_t)startTimeUs);
  updateStatus();
}

// ========== PHONE-INITIATED MODE 2 (non-blocking) ==========
// A parallel path to startMode2(). startMode2() (the physical button hold/release
// flow) is left completely unchanged; both coexist. Nothing here touches the
// timing-critical handleGate1Trigger / processResult / ESP-NOW code.

void armMode2Phone() {
  currentMode = MODE_2_PHONE_ARMED;
  modeTimeout = millis() + MODE_TIMEOUT;
  cdPhase = 0;

  u8g2.clearBuffer();
  u8g2.setFont(u8g2_font_ncenB08_tr);
  u8g2.drawStr(0, 10, "MODE 2");
  u8g2.setFont(u8g2_font_ncenB14_tr);
  u8g2.drawStr(5, 38, "ARMED");
  u8g2.setFont(u8g2_font_ncenB08_tr);
  u8g2.drawStr(0, 56, "Start from phone");
  u8g2.sendBuffer();

  Serial.println(">>> MODE 2 ARMED (phone)");
  emitState();          // M2_ARMED
  updateStatus();
}

// Enter the countdown and schedule its milestones. minUnits/maxUnits are the
// random-hold bounds in 100ms units; 0,0 => gate default (2-5 s).
void startSequencePhone(uint8_t minUnits, uint8_t maxUnits) {
  unsigned long now = millis();

  unsigned long minMs, maxMs;
  if (minUnits == 0 && maxUnits == 0) {
    minMs = CD_HOLD_MIN_DEFAULT;
    maxMs = CD_HOLD_MAX_DEFAULT;
  } else {
    minMs = (unsigned long)minUnits * 100UL;
    maxMs = (unsigned long)maxUnits * 100UL;
  }
  if (maxMs < minMs) { unsigned long t = minMs; minMs = maxMs; maxMs = t; }  // tolerate swapped
  if (minMs < 300) minMs = 300;          // clamp to sane bounds
  if (maxMs > 15000) maxMs = 15000;
  if (maxMs < minMs) maxMs = minMs;

  // True-random hold (RF-seeded TRNG while WiFi/BT are active) so it can't be timed.
  unsigned long holdMs = minMs + (esp_random() % (maxMs - minMs + 1UL));

  currentMode      = MODE_2_COUNTDOWN;
  cdPhase          = 1;
  cdSetAtMs        = now + CD_MARKS_MS;
  cdGoImminentAtMs = cdSetAtMs + CD_SET_MS;
  cdGoAtMs         = cdGoImminentAtMs + holdMs;
  modeTimeout      = now + MODE_TIMEOUT;

  drawCountdownScreen("MARKS");
  Serial.printf(">>> MODE 2 COUNTDOWN (random hold %lu ms)\n", holdMs);
  emitState();          // M2_COUNTDOWN
  emitCountdown(1);     // phase 1: on your marks
  updateStatus();
}

// Called every loop() pass. Advances the countdown with rollover-safe timing
// and fires GO when due. No delay() / no blocking.
void serviceCountdown(unsigned long now) {
  if (currentMode != MODE_2_COUNTDOWN) return;

  if (cdPhase < 2 && (long)(now - cdSetAtMs) >= 0) {
    cdPhase = 2;
    drawCountdownScreen("SET");
    emitCountdown(2);   // phase 2: set
  }
  if (cdPhase < 3 && (long)(now - cdGoImminentAtMs) >= 0) {
    cdPhase = 3;
    drawCountdownScreen("...");
    emitCountdown(3);   // phase 3: go-imminent (random window has begun)
  }
  if ((long)(now - cdGoAtMs) >= 0) {
    fireGoPhone();
  }
}

// The GO instant for the phone path. Mirrors the tail of startMode2() exactly,
// then hands off to the existing MODE_2_WAITING_GATE1 -> Gate1 -> Gate2 flow.
void fireGoPhone() {
  flushLunaBuffer();          // clean baseline BEFORE the clock starts
  startTimeUs = micros();
  currentMode = MODE_2_WAITING_GATE1;
  modeTimeout = millis() + MODE_TIMEOUT;

  u8g2.clearBuffer();
  u8g2.setFont(u8g2_font_ncenB08_tr);
  u8g2.drawStr(0, 10, "MODE 2");
  u8g2.setFont(u8g2_font_ncenB24_tr);
  u8g2.drawStr(30, 45, "GO!");
  u8g2.setFont(u8g2_font_ncenB08_tr);
  u8g2.drawStr(0, 60, "Run to Gate 1");
  u8g2.sendBuffer();

  Serial.printf(">>> MODE 2 (phone) GO @ %lu us\n", startTimeUs);
  emitState();                    // now M2_TO_GATE1
  emitGo(2, (uint32_t)startTimeUs);
  updateStatus();
}

// ========== GATE 1 TRIGGER ==========
void handleGate1Trigger(unsigned long nowUs) {
  gate1Triggered = true;
  gate1TriggerUs = nowUs;
  Serial.println("!!! GATE 1 TRIGGERED !!!");

  GateData data = {};
  data.gateNumber = 1;
  data.isResult = false;
  data.timestampUs = nowUs;

  if (currentMode == MODE_1_ACTIVATED) {
    data.mode = 1;
    currentMode = MODE_1_WAITING_GATE2;
    modeTimeout = millis() + MODE_TIMEOUT;
    emitState();                          // now M1_RUNNING
    emitStart(1, (uint32_t)nowUs);        // Mode 1 clock start

  } else if (currentMode == MODE_2_WAITING_GATE1) {
    data.mode = 2;
    firstSplitUs = gate1TriggerUs - startTimeUs;
    currentMode = MODE_2_WAITING_GATE2;
    modeTimeout = millis() + MODE_TIMEOUT;
    Serial.printf("Split 1: %.3fs\n", firstSplitUs / 1000000.0);
    emitState();                          // now M2_TO_GATE2
    emitSplit(2, 1, (uint32_t)((firstSplitUs + 500) / 1000));  // round at source
  }

  packetSentUs = micros();  // stamp right before send for round-trip calc
  esp_now_send(gate2MAC, (uint8_t *)&data, sizeof(data));
}

// ========== PROCESS + SHOW RESULT ==========
void processResult(GateData& received) {
  // --- Round-trip latency correction ---
  // resultRecvUs - packetSentUs = full round trip INCLUDING the time Gate 2
  // spent waiting for its beam break (received.deltaUs). Subtract that wait to
  // isolate pure two-way network+processing latency, then halve it for one-way.
  unsigned long roundTripUs = resultRecvUs - packetSentUs;
  long networkUs = (long)roundTripUs - (long)received.deltaUs;
  if (networkUs < 0) networkUs = 0;            // guard against jitter/underflow
  unsigned long oneWayUs = (unsigned long)networkUs / 2;

  // True time from Gate 1 trigger to Gate 2 trigger, on Gate 1's clock:
  unsigned long g1ToG2Us = oneWayUs + received.deltaUs;

  unsigned long totalUs, split1Us, split2Us;

  if (received.mode == 1) {
    totalUs  = g1ToG2Us;
    split1Us = 0;
    split2Us = 0;
  } else {
    split1Us = firstSplitUs;
    split2Us = g1ToG2Us;
    totalUs  = split1Us + split2Us;
  }

  // Convert to ms (rounded) for storage/display
  unsigned long totalMs  = (totalUs  + 500) / 1000;
  unsigned long split1Ms = (split1Us + 500) / 1000;
  unsigned long split2Ms = (split2Us + 500) / 1000;

  if (runCount < MAX_RUNS) {
    sessionRuns[runCount].mode     = received.mode;
    sessionRuns[runCount].totalMs  = totalMs;
    sessionRuns[runCount].split1Ms = split1Ms;
    sessionRuns[runCount].split2Ms = split2Ms;
    runCount++;
  }

  Serial.printf("Net round-trip: %lu us, one-way est: %lu us\n", roundTripUs, oneWayUs);

  u8g2.clearBuffer();

  if (received.mode == 1) {
    char timeBuf[16];
    sprintf(timeBuf, "%.3fs", totalMs / 1000.0);
    u8g2.setFont(u8g2_font_ncenB08_tr);
    u8g2.drawStr(0, 10, "MODE 1  RESULT");
    u8g2.setFont(u8g2_font_ncenB18_tr);
    u8g2.drawStr(0, 36, timeBuf);
    u8g2.setFont(u8g2_font_ncenB08_tr);
    u8g2.drawStr(0, 56, "Press button to cont.");
    Serial.printf(">>> RUN %d MODE 1: %.3fs\n", runCount, totalMs / 1000.0);

  } else {
    char s1Buf[16], s2Buf[16], totBuf[16];
    sprintf(s1Buf, "S1: %.3fs", split1Ms / 1000.0);
    sprintf(s2Buf, "S2: %.3fs", split2Ms / 1000.0);
    sprintf(totBuf, "Total: %.3fs", totalMs / 1000.0);
    u8g2.setFont(u8g2_font_ncenB08_tr);
    u8g2.drawStr(0, 10, "MODE 2  RESULT");
    u8g2.drawStr(0, 24, s1Buf);
    u8g2.drawStr(0, 38, s2Buf);
    u8g2.drawStr(0, 52, totBuf);
    u8g2.drawStr(0, 63, "Press button to cont.");
    Serial.printf(">>> RUN %d MODE 2: S1=%.3f S2=%.3f Tot=%.3fs\n",
                  runCount, split1Ms / 1000.0, split2Ms / 1000.0, totalMs / 1000.0);
  }

  u8g2.sendBuffer();
  currentMode = MODE_SHOWING_RESULT;

  // --- BLE: authoritative result out ---
  uint8_t flags = 0x01;                 // bit0 = valid result
  if (!finishLinkOk) flags |= 0x02;     // bit1 = false/early start proxy (link issue)
  uint8_t mode = (uint8_t)received.mode;
  updateLastResult(mode, totalMs, split1Ms, split2Ms, flags, (uint8_t)runCount);
  emitFinish(mode, totalMs, split1Ms, split2Ms, flags);
  emitState();                          // now RESULT
  updateStatus();
}

// ========== READ GATE 1 ==========
bool readGate1() {
  if (!readLuna(distance)) return false;
  unsigned long nowUs = micros();

  bool triggered = (distance > 0 && distance <= GATE_THRESHOLD);

  if (triggered && !lastGate1State) {
    if ((nowUs - gate1DebounceUs) > SENSOR_DEBOUNCE_US) {
      gate1DebounceUs = nowUs;
      lastGate1State = true;
      if (!gate1Triggered &&
          (currentMode == MODE_1_ACTIVATED || currentMode == MODE_2_WAITING_GATE1)) {
        handleGate1Trigger(nowUs);
      }
    }
  } else if (!triggered) {
    lastGate1State = false;
  }
  return false;
}
