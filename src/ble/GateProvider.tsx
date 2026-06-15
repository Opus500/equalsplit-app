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
import {
  buildAnchor,
  gateUsToPhoneMs,
  type ClockAnchor,
  type ClockSyncResult,
  type PingSample,
} from './clockSync';

const perfNow = () =>
  typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now();
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type ConnStatus = 'idle' | 'scanning' | 'connecting' | 'connected' | 'reconnecting';
// atMs = phone monotonic timestamp when the notification was delivered to JS.
type EventListener = (raw: Uint8Array, parsed: GateEvent | null, atMs: number) => void;

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
  clockSync: ClockSyncResult | null;
  syncing: boolean;
  syncClock: (pings?: number) => Promise<ClockSyncResult | null>;
  gateToPhoneMs: (gateUs: number) => number | null;
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
  const [clockSync, setClockSync] = useState<ClockSyncResult | null>(null);
  const [syncing, setSyncing] = useState(false);

  const listeners = useRef<Set<EventListener>>(new Set());
  const subs = useRef<Subscription[]>([]);
  const disconnectSub = useRef<Subscription | null>(null);
  const scanTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deviceRef = useRef<Device | null>(null);
  const intentionalRef = useRef(false); // user asked to disconnect — don't auto-reconnect
  const reconnectingRef = useRef(false);
  const attemptReconnectRef = useRef<() => void>(() => {});
  const clockAnchorRef = useRef<ClockAnchor | null>(null);
  // When set, the next Status notification resolves a pending PING (clock sync).
  const statusPingRef = useRef<((gateUs: number, atMs: number) => void) | null>(null);

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

  // Wire up a freshly-connected device: monitors, reads, and a disconnect handler
  // that auto-reconnects unless the user asked to disconnect. Reused on both the
  // initial connect and every reconnect so state always resyncs.
  const attachDevice = useCallback(
    (d: Device) => {
      cleanupConnection();
      deviceRef.current = d;
      setDevice(d);
      setStatus('connected');

      disconnectSub.current = manager.onDeviceDisconnected(d.id, () => {
        cleanupConnection();
        setDevice(null);
        setGateStatus(null);
        if (intentionalRef.current) {
          setStatus('idle');
          return;
        }
        attemptReconnectRef.current();
      });

      // Resync on (re)connect: re-read Status + LastResult (reliable reads).
      readStatus(d)
        .then((st) => st && setGateStatus(parseStatus(st)))
        .catch(() => {});
      readLastResult(d)
        .then((lr) => lr && setLastResult(parseLastResult(lr)))
        .catch(() => {});

      subs.current.push(
        monitorEvents(
          d,
          (raw) => {
            const atMs = perfNow(); // capture arrival ASAP, closest to BLE delivery
            const parsed = parseEvent(raw);
            listeners.current.forEach((l) => l(raw, parsed, atMs));
          },
          () => {},
        ),
      );
      subs.current.push(
        monitorStatus(
          d,
          (raw) => {
            const atMs = perfNow();
            const s = parseStatus(raw);
            if (s) {
              setGateStatus(s);
              const resolve = statusPingRef.current;
              if (resolve) {
                statusPingRef.current = null;
                resolve(s.gateMicros, atMs);
              }
            }
          },
          () => {},
        ),
      );
    },
    [cleanupConnection],
  );

  // Retry reconnecting to the last device with backoff until it succeeds or the
  // user cancels (disconnect). Each attempt fails fast via the connect timeout.
  const attemptReconnect = useCallback(async () => {
    const d = deviceRef.current;
    if (!d || intentionalRef.current || reconnectingRef.current) {
      if (!d) setStatus('idle');
      return;
    }
    reconnectingRef.current = true;
    setStatus('reconnecting');
    for (let i = 0; i < 10; i++) {
      if (intentionalRef.current) break;
      try {
        const rd = await connect(d);
        reconnectingRef.current = false;
        attachDevice(rd);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, Math.min(1000 + i * 500, 4000)));
      }
    }
    reconnectingRef.current = false;
    if (!intentionalRef.current) deviceRef.current = null;
    setStatus('idle');
  }, [attachDevice]);

  useEffect(() => {
    attemptReconnectRef.current = () => {
      attemptReconnect();
    };
  }, [attemptReconnect]);

  const connectTo = useCallback(
    async (target: Device) => {
      stopScan();
      if (scanTimer.current) clearTimeout(scanTimer.current);
      intentionalRef.current = false;
      reconnectingRef.current = false;
      setStatus('connecting');
      try {
        const d = await connect(target);
        attachDevice(d);
      } catch {
        setStatus('idle');
      }
    },
    [attachDevice],
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
    intentionalRef.current = true; // stop any auto-reconnect loop
    reconnectingRef.current = false;
    const d = deviceRef.current;
    deviceRef.current = null;
    if (d) {
      try {
        await d.cancelConnection();
      } catch {
        /* already gone */
      }
    }
    setDevice(null);
    setStatus('idle');
  }, []);

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

  // NTP-style clock sync: PING repeatedly; each PING makes the gate refresh the
  // Status characteristic (gate_micros) and notify; the reply resolves the ping.
  // NOTE: this depends on gate->phone NOTIFICATIONS, which drop on this setup
  // (same root cause as the FINISH-recovery work). The write (PING) uses the SAME
  // path as the working ARM command; if pings reach the gate but no sample lands,
  // it's the notification reply being lost — the logs below show exactly that.
  // Hard-capped at ~3s so it can never wedge the UI; falls back to fixed offset.
  const syncClock = useCallback(async (pings = 8): Promise<ClockSyncResult | null> => {
    const d = deviceRef.current;
    console.log(`[syncClock] start (device=${d ? d.id : 'null'})`);
    if (!d) {
      console.warn('[syncClock] aborted: no device');
      return null;
    }
    setSyncing(true);
    const samples: PingSample[] = [];
    const deadline = perfNow() + 3000;
    try {
      for (let i = 0; i < pings; i++) {
        if (perfNow() >= deadline) {
          console.log('[syncClock] 3s deadline reached — stopping');
          break;
        }
        const tSend = perfNow();
        console.log(`[syncClock] ping ${i + 1}/${pings}: writing PING…`);
        const got = await new Promise<{ gateUs: number; atMs: number } | null>((resolve) => {
          statusPingRef.current = (gateUs, atMs) => resolve({ gateUs, atMs });
          sendCommand(d, Op.Ping)
            .then(() => console.log(`[syncClock] ping ${i + 1}: write OK`))
            .catch((e) => console.warn(`[syncClock] ping ${i + 1}: write FAILED`, String(e)));
          setTimeout(() => {
            if (statusPingRef.current) {
              statusPingRef.current = null;
              resolve(null);
            }
          }, 350);
        });
        if (got) {
          const rttMs = got.atMs - tSend;
          console.log(`[syncClock] ping ${i + 1}: reply rtt=${rttMs.toFixed(1)}ms`);
          samples.push({ rttMs, gateUs: got.gateUs, midPhoneMs: tSend + rttMs / 2 });
        } else {
          console.log(`[syncClock] ping ${i + 1}: TIMEOUT (no Status notification back)`);
        }
        await delay(30);
      }
    } catch (e) {
      console.warn('[syncClock] threw:', String(e));
    }
    const result = buildAnchor(samples);
    console.log(`[syncClock] done: ${samples.length} sample(s); anchor=${result ? 'set' : 'NONE → fixed offset'}`);
    if (result) {
      clockAnchorRef.current = result.anchor;
      setClockSync(result);
    }
    setSyncing(false);
    return result;
  }, []);

  const gateToPhoneMs = useCallback((gateUs: number): number | null => {
    return clockAnchorRef.current ? gateUsToPhoneMs(gateUs, clockAnchorRef.current) : null;
  }, []);

  // Auto-sync once whenever we (re)connect (the gate is idle then).
  useEffect(() => {
    if (status === 'connected') {
      const t = setTimeout(() => syncClock(), 1200);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [status, syncClock]);

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
    clockSync,
    syncing,
    syncClock,
    gateToPhoneMs,
    subscribe,
  };

  return <GateContext.Provider value={value}>{children}</GateContext.Provider>;
}

export function useGate(): GateContextValue {
  const ctx = useContext(GateContext);
  if (!ctx) throw new Error('useGate must be used within a GateProvider');
  return ctx;
}
