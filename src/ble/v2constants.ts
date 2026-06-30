// EqualSplit BLE/wire contract v2 — the "write-once dumb gate" raw-event layer.
// Mirrors the firmware #defines and docs/BLE-CONTRACT.md §5. Kept SEPARATE from
// the v1 constants.ts so that, at cutover (§13), deleting the v1 layer is a clean
// file removal. The frame-type number space is globally disjoint from v1
// (v1 commands 0x01–0x06, events 0x10–0x15/0x1e), so both share the BLE channels
// during the phased migration.

export const PROTO_VERSION_V2 = 2;

// Reuses the v1 GATT service/characteristics (only the frame bytes differ).
// Re-exported here so the v2 layer never imports from the v1 constants module.
export { UUID } from './constants';

/** Event frame types (gate → phone), 0x01–0x0F. Byte 0 of a 7-byte event. */
export enum V2Evt {
  BeamBreak = 0x01,
  BeamClear = 0x02,
  BuzzerFired = 0x03,
  ButtonPress = 0x04,
}

/** Link / discovery, 0x20–0x2F. */
export enum V2Link {
  Heartbeat = 0x20,
  TimeSync = 0x21, // gate↔gate only, never relayed to the app
}

/** Commands (phone → bridge; targeted ones relayed gate→gate), 0x30–0x3F. */
export enum V2Cmd {
  AssignIds = 0x30,
  SetThreshold = 0x31,
  BuzzerFire = 0x32,
  ClearQueue = 0x33,
  Ping = 0x34,
  GetStatus = 0x35,
}

/** Replies (gate → phone), 0x40–0x4F. */
export enum V2Reply {
  PingReply = 0x40,
  StatusReply = 0x41,
}

/** gate_id targeting: 0 = unassigned, 1..0xFE = assigned, 0xFF = all gates. */
export const GATE_ID_UNASSIGNED = 0x00;
export const GATE_ID_ALL = 0xff;

/** STATUS_REPLY caps bitfield (§9). */
export const CAP_HAS_DISPLAY = 0x01;
export const CAP_HAS_BUTTONS = 0x02;
export const CAP_BUZZER_WIRED = 0x04;
export const CAP_TIME_SYNCED = 0x08;

export const BATTERY_NOT_SENSED = 0xff;
