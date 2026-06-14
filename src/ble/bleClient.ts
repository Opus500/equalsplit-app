// Thin wrapper over react-native-ble-plx for the EqualSplit start gate.
// Step 1 scope: scan -> connect -> read Status -> stream raw Event bytes.
// Parsing into typed events comes in build-order step 2.

import { BleManager, Device, Subscription, State } from 'react-native-ble-plx';
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
  const connected = await device.connect({ requestMTU: 64 });
  await connected.discoverAllServicesAndCharacteristics();
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
