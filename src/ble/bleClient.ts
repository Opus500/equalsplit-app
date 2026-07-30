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

/** Scan variant for the SET PICKER only. Uses allowDuplicates so the scan-response
 *  manufacturer data (the g1-a3 set byte, which is NOT in the primary advert) is
 *  captured — the first iOS discovery report for a peripheral can lack it, and a
 *  later duplicate carries it. Kept SEPARATE from scanForGate so the working
 *  one-tap/auto-reconnect paths (allowDuplicates:false) are untouched. */
export function scanForGatesWithData(
  onFound: (device: Device) => void,
  onError: (e: Error) => void,
): void {
  manager.startDeviceScan([UUID.service], { allowDuplicates: true }, (error, device) => {
    if (error) {
      onError(error);
      return;
    }
    if (device) onFound(device);
  });
}

/** OS-held gate connections (links the native stack kept that the app forgot).
 *  A timed-out connect can complete natively AFTER ble-plx rejects — the gate
 *  honors that phantom link and stops advertising, so scans find nothing until
 *  an app restart. Adopting the held link instead heals the wedge instantly. */
export async function heldGateConnections(): Promise<Device[]> {
  try {
    return await manager.connectedDevices([UUID.service]);
  } catch {
    return [];
  }
}

export async function connect(device: Device): Promise<Device> {
  // Adopt first: if the OS already holds this link (phantom from a timed-out
  // attempt, or a still-live link after a JS-side state loss), connecting again
  // would fail — just discover and use it.
  try {
    if (await device.isConnected()) {
      await device.discoverAllServicesAndCharacteristics();
      return device;
    }
  } catch {
    /* fall through to a fresh connect */
  }
  try {
    // timeout so a failed (re)connect attempt rejects instead of hanging forever.
    const connected = await device.connect({ requestMTU: 64, timeout: 10000 });
    await connected.discoverAllServicesAndCharacteristics();
    return await tuneConnection(connected);
  } catch (e) {
    // Abort any still-pending native connect so it can't complete later as a
    // phantom link the gate honors while the app scans in vain (the exact state
    // that used to require an app restart to clear).
    try {
      await device.cancelConnection();
    } catch {
      /* not connected — fine */
    }
    throw e;
  }
}

async function tuneConnection(connected: Device): Promise<Device> {
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
