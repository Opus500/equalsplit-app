// EqualSplit BLE contract v1 — mirrors docs/BLE-CONTRACT.md.
// Keep this file and the firmware in lockstep.

export const PROTO_VERSION = 1;
export const DEVICE_NAME_PREFIX = 'EqualSplit';

const u = (group: string) => `7E5D${group}-9A1B-4C2D-8E3F-1A2B3C4D5E6F`;

export const UUID = {
  service: u('0001'),
  command: u('0002'),
  event: u('0003'),
  lastResult: u('0004'),
  status: u('0005'),
} as const;

/** Command opcodes (phone → gate), Command characteristic, fixed 4 bytes. */
export enum Op {
  ArmMode1 = 0x01,
  ArmMode2 = 0x02,
  StartSequence = 0x03,
  Reset = 0x04,
  GoNow = 0x05,
  Ping = 0x06,
}

/** Event types (gate → phone), Event characteristic. */
export enum Evt {
  State = 0x10,
  Countdown = 0x11,
  Go = 0x12,
  Start = 0x13,
  Split = 0x14,
  Finish = 0x15,
  Notice = 0x1e,
}

/** Gate state enum, mirrors firmware SystemMode. */
export enum GateState {
  Idle = 0,
  Result = 1,
  M1Armed = 2,
  M1Running = 3,
  M2Armed = 4,
  M2ToGate1 = 5,
  M2ToGate2 = 6,
  M2Countdown = 7,
}

export const EVT_NAME: Record<number, string> = {
  [Evt.State]: 'STATE',
  [Evt.Countdown]: 'COUNTDOWN',
  [Evt.Go]: 'GO',
  [Evt.Start]: 'START',
  [Evt.Split]: 'SPLIT',
  [Evt.Finish]: 'FINISH',
  [Evt.Notice]: 'NOTICE',
};

export const STATE_NAME: Record<number, string> = {
  [GateState.Idle]: 'IDLE',
  [GateState.Result]: 'RESULT',
  [GateState.M1Armed]: 'M1_ARMED',
  [GateState.M1Running]: 'M1_RUNNING',
  [GateState.M2Armed]: 'M2_ARMED',
  [GateState.M2ToGate1]: 'M2_TO_GATE1',
  [GateState.M2ToGate2]: 'M2_TO_GATE2',
  [GateState.M2Countdown]: 'M2_COUNTDOWN',
};

export const NOTICE_NAME: Record<number, string> = {
  1: 'mode timeout / reset',
  2: 'finish-gate send failed',
  3: 'double-trigger ignored',
  4: 'command rejected',
};
