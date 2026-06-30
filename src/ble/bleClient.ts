// Thin wrapper over react-native-ble-plx for the EqualSplit start gate.
// scan -> connect -> read Status -> stream raw Event/Status bytes -> send commands.

import { Platform } from 'react-native';
import {
  BleManager,
  ConnectionPriority,
  Device,
  Subscription,
  State,
} from 'react-native-ble-plx';
import { UUID, Op } from './constants';
import { bytesToBase64, base64ToBytes } from './base64';

export const manager = new BleManager();

export function onBleStateChange(cb: (s: State) => void): Subscription {
  return manager.onStateChange(cb, true);
}

export function scanForGate(
  onFound: (device: Device) => void,
  onError: (e: Error) => void,
): void {
  manager.startDeviceScan([UUID.service], { allowDuplicates: false }, (error, device) => {
    if (error) {
      onError(error);
      return;
    }
    if (device) onFound(device);
  });
}

export function stopScan(): void {
  manager.stopDeviceScan();
}

export async function connect(device: Device): Promise<Device> {
  // timeout so a failed (re)connect attempt rejects instead of hanging forever.
  const connected = await device.connect({ requestMTU: 64, timeout: 10000 });
  await connected.discoverAllServicesAndCharacteristics();
  // Ask for the fastest connection interval (~11-15ms) so live timing feels tight.
  // Android only: iOS connection parameters are dictated by the peripheral (the
  // gate requests its preferred interval), so this is a no-op there.
  if (Platform.OS === 'android') {
    try {
      await connected.requestConnectionPriority(ConnectionPriority.High);
    } catch {
      /* best-effort; not fatal if the stack rejects it */
    }
  }
  return connected;
}

export async function readStatus(device: Device): Promise<Uint8Array | null> {
  const ch = await device.readCharacteristicForService(UUID.service, UUID.status);
  return ch.value ? base64ToBytes(ch.value) : null;
}

export async function readLastResult(device: Device): Promise<Uint8Array | null> {
  const ch = await device.readCharacteristicForService(UUID.service, UUID.lastResult);
  return ch.value ? base64ToBytes(ch.value) : null;
}

export function monitorEvents(
  device: Device,
  onEvent: (bytes: Uint8Array) => void,
  onError: (e: Error) => void,
): Subscription {
  return device.monitorCharacteristicForService(UUID.service, UUID.event, (error, ch) => {
    if (error) {
      onError(error);
      return;
    }
    if (ch?.value) onEvent(base64ToBytes(ch.value));
  });
}

export function monitorStatus(
  device: Device,
  onStatus: (bytes: Uint8Array) => void,
  onError: (e: Error) => void,
): Subscription {
  return device.monitorCharacteristicForService(UUID.service, UUID.status, (error, ch) => {
    if (error) {
      onError(error);
      return;
    }
    if (ch?.value) onStatus(base64ToBytes(ch.value));
  });
}

export async function sendCommand(
  device: Device,
  op: Op,
  arg0 = 0,
  arg1 = 0,
  arg2 = 0,
): Promise<void> {
  const payload = bytesToBase64(new Uint8Array([op, arg0, arg1, arg2]));
  await device.writeCharacteristicWithResponseForService(UUID.service, UUID.command, payload);
}

/** Write a raw, variable-length v2 command frame (built by src/ble/v2.ts) to the
 *  same Command characteristic. v2 opcodes (0x30+) are disjoint from v1's, so the
 *  gate routes by the first byte. */
export async function sendV2Frame(device: Device, bytes: Uint8Array): Promise<void> {
  await device.writeCharacteristicWithResponseForService(
    UUID.service,
    UUID.command,
    bytesToBase64(bytes),
  );
}
