// Owns the single BLE connection to the start gate and exposes it via useGate().
// Lives at the app root so the connection + event stream persist across screens.
// Screens subscribe to parsed events; the provider holds connection + gate status.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { PermissionsAndroid, Platform } from 'react-native';
import type { Device, Subscription } from 'react-native-ble-plx';

import {
  connect,
  manager,
  monitorEvents,
  monitorStatus,
  onBleStateChange,
  readLastResult,
  readStatus,
  scanForGate,
  sendCommand,
  stopScan,
} from './bleClient';
import { Op } from './constants';
import { parseEvent, parseStatus, type GateEvent, type GateStatus, type LastResult } from './events';
import { parseLastResult } from './events';

export type ConnStatus = 'idle' | 'scanning' | 'connecting' | 'connected';
type EventListener = (raw: Uint8Array, parsed: GateEvent | null) => void;

type GateContextValue = {
  adapterOn: boolean;
  status: ConnStatus;
  devices: Device[];
  device: Device | null;
  gateStatus: GateStatus | null;
  lastResult: LastResult | null;
  scan: () => Promise<void>;
  quickConnect: () => Promise<void>;
  connectTo: (d: Device) => Promise<void>;
  disconnect: () => Promise<void>;
  arm1: () => Promise<void>;
  arm2: () => Promise<void>;
  startSequence: (minUnits?: number, maxUnits?: number) => Promise<void>;
  reset: () => Promise<void>;
  goNow: () => Promise<void>;
  readStatusNow: () => Promise<GateStatus | null>;
  readLastResultNow: () => Promise<LastResult | null>;
  subscribe: (cb: EventListener) => () => void;
};

const GateContext = createContext<GateContextValue | null>(null);

async function ensureAndroidPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const sdk = typeof Platform.Version === 'number' ? Platform.Version : 0;
  const perms =
    sdk >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        ]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
  const res = await PermissionsAndroid.requestMultiple(perms);
  return Object.values(res).every((v) => v === PermissionsAndroid.RESULTS.GRANTED);
}

export function GateProvider({ children }: { children: ReactNode }) {
  const [adapterOn, setAdapterOn] = useState(false);
  const [status, setStatus] = useState<ConnStatus>('idle');
  const [devices, setDevices] = useState<Record<string, Device>>({});
  const [device, setDevice] = useState<Device | null>(null);
  const [gateStatus, setGateStatus] = useState<GateStatus | null>(null);
  const [lastResult, setLastResult] = useState<LastResult | null>(null);

  const listeners = useRef<Set<EventListener>>(new Set());
  const subs = useRef<Subscription[]>([]);
  const disconnectSub = useRef<Subscription | null>(null);
  const scanTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const s = onBleStateChange((st) => setAdapterOn(st === 'PoweredOn'));
    return () => s.remove();
  }, []);

  const subscribe = useCallback((cb: EventListener) => {
    listeners.current.add(cb);
    return () => {
      listeners.current.delete(cb);
    };
  }, []);

  const cleanupConnection = useCallback(() => {
    subs.current.forEach((s) => s.remove());
    subs.current = [];
    disconnectSub.current?.remove();
    disconnectSub.current = null;
  }, []);

  useEffect(() => () => cleanupConnection(), [cleanupConnection]);

  const connectTo = useCallback(
    async (target: Device) => {
      stopScan();
      if (scanTimer.current) clearTimeout(scanTimer.current);
      setStatus('connecting');
      try {
        const d = await connect(target);
        setDevice(d);
        setStatus('connected');

        disconnectSub.current = manager.onDeviceDisconnected(d.id, () => {
          cleanupConnection();
          setDevice(null);
          setGateStatus(null);
          setStatus('idle');
        });

        const st = await readStatus(d);
        if (st) setGateStatus(parseStatus(st));
        const lr = await readLastResult(d);
        if (lr) setLastResult(parseLastResult(lr));

        subs.current.push(
          monitorEvents(
            d,
            (raw) => {
              const parsed = parseEvent(raw);
              listeners.current.forEach((l) => l(raw, parsed));
            },
            () => {},
          ),
        );
        subs.current.push(
          monitorStatus(
            d,
            (raw) => {
              const s = parseStatus(raw);
              if (s) setGateStatus(s);
            },
            () => {},
          ),
        );
      } catch {
        setStatus('idle');
      }
    },
    [cleanupConnection],
  );

  const scan = useCallback(async () => {
    if (!(await ensureAndroidPermissions())) return;
    setDevices({});
    setStatus('scanning');
    scanForGate(
      (d) => setDevices((prev) => (prev[d.id] ? prev : { ...prev, [d.id]: d })),
      () => setStatus('idle'),
    );
    scanTimer.current = setTimeout(() => {
      stopScan();
      setStatus((s) => (s === 'scanning' ? 'idle' : s));
    }, 12000);
  }, []);

  // One-tap: scan and auto-connect to the first gate that advertises the service.
  const quickConnect = useCallback(async () => {
    if (!(await ensureAndroidPermissions())) return;
    setStatus('scanning');
    let claimed = false;
    scanForGate(
      (d) => {
        if (claimed) return;
        claimed = true;
        connectTo(d);
      },
      () => setStatus('idle'),
    );
    scanTimer.current = setTimeout(() => {
      if (!claimed) {
        stopScan();
        setStatus((s) => (s === 'scanning' ? 'idle' : s));
      }
    }, 12000);
  }, [connectTo]);

  const disconnect = useCallback(async () => {
    if (device) {
      try {
        await device.cancelConnection();
      } catch {
        /* already gone */
      }
    }
  }, [device]);

  // Reliable on-demand reads (GATT reads don't get dropped the way notifications
  // can), used by the Timer screen to reconcile/recover from missed events.
  const readStatusNow = useCallback(async (): Promise<GateStatus | null> => {
    if (!device) return null;
    try {
      const raw = await readStatus(device);
      const s = raw ? parseStatus(raw) : null;
      if (s) setGateStatus(s);
      return s;
    } catch {
      return null;
    }
  }, [device]);

  const readLastResultNow = useCallback(async (): Promise<LastResult | null> => {
    if (!device) return null;
    try {
      const raw = await readLastResult(device);
      const lr = raw ? parseLastResult(raw) : null;
      if (lr) setLastResult(lr);
      return lr;
    } catch {
      return null;
    }
  }, [device]);

  const send = useCallback(
    async (op: Op, a0 = 0, a1 = 0) => {
      if (device) await sendCommand(device, op, a0, a1);
    },
    [device],
  );

  const arm1 = useCallback(() => send(Op.ArmMode1), [send]);
  const arm2 = useCallback(() => send(Op.ArmMode2), [send]);
  const startSequence = useCallback((min = 0, max = 0) => send(Op.StartSequence, min, max), [send]);
  const reset = useCallback(() => send(Op.Reset), [send]);
  const goNow = useCallback(() => send(Op.GoNow), [send]);

  const value: GateContextValue = {
    adapterOn,
    status,
    devices: Object.values(devices),
    device,
    gateStatus,
    lastResult,
    scan,
    quickConnect,
    connectTo,
    disconnect,
    arm1,
    arm2,
    startSequence,
    reset,
    goNow,
    readStatusNow,
    readLastResultNow,
    subscribe,
  };

  return <GateContext.Provider value={value}>{children}</GateContext.Provider>;
}

export function useGate(): GateContextValue {
  const ctx = useContext(GateContext);
  if (!ctx) throw new Error('useGate must be used within a GateProvider');
  return ctx;
}
