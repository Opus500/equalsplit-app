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
  if (len != sizeof(GateData)) return;
  GateData received;
  memcpy(&received, data, sizeof(received));

  if (!received.isResult && received.gateNumber == 1) {
    packetRecvUs = micros();   // stamp arrival immediately, in ISR context
    pendingMode = received.mode;
    newPacket = true;
  }
}

// ========== FORWARD DECLARATION ==========
void handleGate2Trigger(unsigned long nowUs);

// ========== SETUP ==========
void setup() {
  Serial.begin(115200);
  Serial2.begin(115200, SERIAL_8N1, LUNA_RX, LUNA_TX);
  delay(500);  // let the Luna boot before sending config

  setLunaFrameRate(250);

  WiFi.mode(WIFI_STA);
  Serial.print("Gate 2 MAC: ");
  Serial.println(WiFi.macAddress());

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

  Serial.println("Gate 2 ready - waiting for Gate 1 signal...");
}

// ========== MAIN LOOP ==========
void loop() {
  // Pick up a newly-received trigger packet (set in ISR)
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

  if (waitingForGate2 && readLuna(distance)) {
    unsigned long nowUs = micros();
    if (nowUs >= gate2EnableUs) {
      bool triggered = (distance > 0 && distance <= GATE_THRESHOLD);
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
  } else if (!waitingForGate2) {
    // drain so the buffer never sits in overflow while idle
    while (Serial2.available()) Serial2.read();
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
