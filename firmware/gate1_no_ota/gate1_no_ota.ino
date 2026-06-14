#include <Wire.h>
#include <U8g2lib.h>
#include <WiFi.h>
#include <esp_now.h>

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
  MODE_2_WAITING_GATE2
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
  Serial.println(status == ESP_NOW_SEND_SUCCESS ? "Send OK" : "Send FAILED");
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

void resetToIdle() {
  currentMode = MODE_IDLE;
  gate1Triggered = false;
  lastTimerStr[0] = '\0';
  idleLockoutUntil = millis() + 500;
  drawIdleScreen();
  Serial.println(">>> IDLE");
}

// ========== FORWARD DECLARATIONS ==========
void startMode1();
void startMode2();
void handleGate1Trigger(unsigned long nowUs);
void processResult(GateData& received);
bool readGate1();

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
}

// ========== MAIN LOOP ==========
void loop() {
  unsigned long now = millis();

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

  } else if (currentMode == MODE_2_WAITING_GATE1) {
    data.mode = 2;
    firstSplitUs = gate1TriggerUs - startTimeUs;
    currentMode = MODE_2_WAITING_GATE2;
    modeTimeout = millis() + MODE_TIMEOUT;
    Serial.printf("Split 1: %.3fs\n", firstSplitUs / 1000000.0);
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
