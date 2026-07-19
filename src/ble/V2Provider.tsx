// First-class v2 timing session (Stage 1 of the cutover). A context so the dev
// Lab now — and the main Timer in Stage 2 — share ONE v2 session/engine/offset
// off the shared GateProvider BLE link. Dormant (no subscription, no commands)
// until `active`, so while v1 remains the default the normal app is untouched.
//
// Automatic bring-up on connect: discover gates (heartbeats) -> provisional
// ASSIGN_IDS (distinct ids) -> GET_STATUS to learn caps -> final ASSIGN_IDS so
// the has_display gate is id 1 (start; swappable) -> CLEAR_QUEUE -> wait both
// time_synced -> PING display offset -> ready. IDs are RAM-only, so this re-runs
// on every (re)connect.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { useGate } from './GateProvider';
import { Evt } from './constants';
import { sendV2Frame } from './bleClient';
import {
  parseV2Frame,
  V2RunEngine,
  buildAssignIds,
  buildGetStatus,
  buildPing,
  buildClearQueue,
  type V2Frame,
  type V2Run,
} from './v2';
import { GATE_ID_ALL } from './v2constants';
import { buildAnchor, gateUsToPhoneMs, type ClockAnchor, type PingSample } from './clockSync';
import type { LastResult } from './events';

const perfNow = () =>
  typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now();
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const START_ID = 1;
const FINISH_ID = 2;

function macStrToBytes(mac: string): Uint8Array {
  return Uint8Array.from(mac.split(':').map((h) => parseInt(h, 16)));
}

export type V2Phase = 'idle' | 'discovering' | 'assigning' | 'syncing' | 'ready' | 'error';

export type GateView = {
  id: number | null;
  mac: string;
  role: 'start' | 'finish' | null;
  hasDisplay: boolean;
  timeSynced: boolean;
  thresholdCm: number;
};

export type Comparison = {
  id: string;
  atMs: number;
  v1Ms: number;
  v2Ms: number;
  deltaMs: number;
  synced: boolean;
};

type StatusView = {
  gateId: number;
  thresholdCm: number;
  queueDepth: number;
  fwVer: number;
  timeSynced: boolean;
  hasDisplay: boolean;
  hasButtons: boolean;
  buzzerWired: boolean;
};

export type V2ContextValue = {
  active: boolean;
  setActive: (b: boolean) => void;
  phase: V2Phase;
  connected: boolean;
  ready: boolean;
  gates: GateView[];
  swapRoles: boolean;
  setSwapRoles: (b: boolean) => void;
  engineState: string;
  lastRun: V2Run | null;
  comparisons: Comparison[];
  ping: { rttMs: number; offsetMs: number } | null;
  log: string[];
  bringUp: () => Promise<void>;
  arm: () => Promise<void>;
  resetEngine: () => void;
  clearComparisons: () => void;
  gateToPhoneMs: (gateUs: number) => number | null;
};

const V2Context = createContext<V2ContextValue | null>(null);

export function V2Provider({ children }: { children: ReactNode }) {
  const gate = useGate();
  const engineRef = useRef(new V2RunEngine(START_ID, FINISH_ID));

  const [active, setActive] = useState(false);
  const [phase, setPhase] = useState<V2Phase>('idle');
  const [swapRoles, setSwapRoles] = useState(false);
  const [engineState, setEngineState] = useState<string>(engineRef.current.state);
  const [lastRun, setLastRun] = useState<V2Run | null>(null);
  const [comparisons, setComparisons] = useState<Comparison[]>([]);
  const [ping, setPing] = useState<{ rttMs: number; offsetMs: number } | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [gates, setGates] = useState<GateView[]>([]);

  // Live mirrors (refs) so the async bring-up reads current values, not stale.
  const discoveredRef = useRef<Record<string, number>>({}); // mac -> lastSeenMs
  const statusesRef = useRef<Record<number, StatusView>>({}); // gate_id -> status
  const idToMacRef = useRef<Record<number, string>>({}); // our assignment map
  const anchorRef = useRef<ClockAnchor | null>(null);
  const swapRef = useRef(swapRoles);
  swapRef.current = swapRoles;
  const gateRef = useRef(gate);
  gateRef.current = gate;

  // Pairing (v2 run <-> v1 LastResult) + PING waiters + event de-dupe.
  const pendingV2 = useRef<{ splitMs: number; synced: boolean; atMs: number; token: number } | null>(
    null,
  );
  const runToken = useRef(0);
  const lastPairedRunIndex = useRef(-1);
  const cmpSeq = useRef(0);
  const pingWaiters = useRef<Map<number, (r: { gateMicros: number; atMs: number }) => void>>(
    new Map(),
  );
  const pingCounter = useRef(1);
  const recentKeys = useRef<Set<string>>(new Set());
  const recentKeyOrder = useRef<string[]>([]);

  const bringUpInFlight = useRef(false);
  const broughtUpForConn = useRef(false);

  const pushLog = useCallback((msg: string) => {
    const t = new Date().toLocaleTimeString();
    setLog((prev) => [`${t}  ${msg}`, ...prev].slice(0, 200));
  }, []);

  const rebuildGates = useCallback(() => {
    const byId = idToMacRef.current;
    const st = statusesRef.current;
    const out: GateView[] = [];
    const seen = new Set<string>();
    for (const idStr of Object.keys(byId)) {
      const id = Number(idStr);
      const mac = byId[id];
      seen.add(mac);
      const s = st[id];
      out.push({
        id,
        mac,
        role: id === START_ID ? 'start' : id === FINISH_ID ? 'finish' : null,
        hasDisplay: s?.hasDisplay ?? false,
        timeSynced: s?.timeSynced ?? false,
        thresholdCm: s?.thresholdCm ?? 0,
      });
    }
    // Any discovered-but-unassigned gates (pre-bring-up).
    for (const mac of Object.keys(discoveredRef.current)) {
      if (seen.has(mac)) continue;
      out.push({ id: null, mac, role: null, hasDisplay: false, timeSynced: false, thresholdCm: 0 });
    }
    out.sort((a, b) => (a.id ?? 99) - (b.id ?? 99));
    setGates(out);
  }, []);

  // ---- event stream (only while active) --------------------------------
  useEffect(() => {
    if (!active) return undefined;
    const engine = engineRef.current;

    const emitComparison = (v1Ms: number, v2: { splitMs: number; synced: boolean }, atMs: number) => {
      cmpSeq.current += 1;
      const c: Comparison = {
        id: `${cmpSeq.current}`,
        atMs,
        v1Ms,
        v2Ms: v2.splitMs,
        deltaMs: v2.splitMs - v1Ms,
        synced: v2.synced,
      };
      setComparisons((prev) => [c, ...prev].slice(0, 50));
    };

    const pairV1 = (v1Ms: number, atMs: number, source: string): boolean => {
      const v2 = pendingV2.current;
      if (!v2) return false;
      if (Math.abs(atMs - v2.atMs) > 5000) return false;
      pendingV2.current = null;
      emitComparison(v1Ms, v2, Math.max(atMs, v2.atMs));
      pushLog(`paired via ${source}`);
      return true;
    };

    const pairViaLastResult = async (token: number, attempt: number) => {
      const cur = pendingV2.current;
      if (!cur || cur.token !== token) return;
      let lr: LastResult | null = null;
      try {
        lr = await gateRef.current.readLastResultNow();
      } catch {
        /* retry below */
      }
      if (!pendingV2.current || pendingV2.current.token !== token) return;
      if (lr && lr.runIndex !== lastPairedRunIndex.current) {
        lastPairedRunIndex.current = lr.runIndex;
        pairV1(lr.totalMs, perfNow(), `LastResult run#${lr.runIndex}`);
        return;
      }
      if (attempt < 4) setTimeout(() => pairViaLastResult(token, attempt + 1), 400);
    };

    engine.onRun = (run) => {
      setLastRun(run);
      setEngineState(engine.state);
      runToken.current += 1;
      const token = runToken.current;
      pendingV2.current = { splitMs: run.splitMs, synced: run.synced, atMs: run.finishAtMs, token };
      pushLog(`v2 run split=${run.splitMs}ms${run.synced ? '' : ' (unsynced — withheld)'}`);
      setTimeout(() => pairViaLastResult(token, 0), 450);
    };

    const off = gate.subscribe((raw, parsed, atMs) => {
      if (parsed && parsed.type === Evt.Finish) pairV1(parsed.totalMs, atMs, 'FINISH');
      const f: V2Frame | null = parseV2Frame(raw);
      if (!f) return;
      if (f.kind === 'beam' || f.kind === 'buzzer' || f.kind === 'button') {
        const key = `${f.kind}:${f.gateId}:${f.micros}`;
        if (recentKeys.current.has(key)) return;
        recentKeys.current.add(key);
        recentKeyOrder.current.push(key);
        if (recentKeyOrder.current.length > 128) {
          const old = recentKeyOrder.current.shift();
          if (old) recentKeys.current.delete(old);
        }
      }
      switch (f.kind) {
        case 'heartbeat':
          if (discoveredRef.current[f.mac] === undefined) pushLog(`discovered ${f.mac}`);
          discoveredRef.current[f.mac] = atMs;
          rebuildGates();
          break;
        case 'status':
          statusesRef.current[f.gateId] = {
            gateId: f.gateId,
            thresholdCm: f.thresholdCm,
            queueDepth: f.queueDepth,
            fwVer: f.fwVer,
            timeSynced: f.caps.timeSynced,
            hasDisplay: f.caps.hasDisplay,
            hasButtons: f.caps.hasButtons,
            buzzerWired: f.caps.buzzerWired,
          };
          engine.setSynced(f.gateId, f.caps.timeSynced);
          rebuildGates();
          break;
        case 'pingReply': {
          const w = pingWaiters.current.get(f.appMicros);
          if (w) {
            pingWaiters.current.delete(f.appMicros);
            w({ gateMicros: f.gateMicros, atMs });
          }
          break;
        }
        case 'beam':
          if (f.edge === 'break') {
            engine.onBeamBreak(f.gateId, f.micros, atMs);
            setEngineState(engine.state);
          }
          break;
        default:
          break;
      }
    });
    return off;
  }, [active, gate.subscribe, pushLog, rebuildGates]);

  // ---- low-level helpers ------------------------------------------------
  const sendFrame = useCallback(async (bytes: Uint8Array) => {
    const d = gateRef.current.device;
    if (!d) throw new Error('not connected');
    await sendV2Frame(d, bytes);
  }, []);

  const waitFor = useCallback(
    async (pred: () => boolean, timeoutMs: number, pollMs = 120): Promise<boolean> => {
      const deadline = perfNow() + timeoutMs;
      while (perfNow() < deadline) {
        if (pred()) return true;
        await delay(pollMs);
      }
      return pred();
    },
    [],
  );

  const assign = useCallback(
    async (map: Record<number, string>) => {
      idToMacRef.current = { ...map };
      const entries = Object.keys(map).map((idStr) => ({
        mac: macStrToBytes(map[Number(idStr)]),
        id: Number(idStr),
      }));
      // ESP-NOW is unacked; send twice.
      await sendFrame(buildAssignIds(entries));
      await delay(150);
      await sendFrame(buildAssignIds(entries));
      rebuildGates();
    },
    [sendFrame, rebuildGates],
  );

  const requestStatus = useCallback(async () => {
    await sendFrame(buildGetStatus(GATE_ID_ALL));
  }, [sendFrame]);

  const pingSync = useCallback(async () => {
    const d = gateRef.current.device;
    if (!d) return;
    const samples: PingSample[] = [];
    for (let i = 0; i < 6; i++) {
      const appMicros = pingCounter.current++ >>> 0;
      const tSend = perfNow();
      const got = await new Promise<{ gateMicros: number; atMs: number } | null>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (v: { gateMicros: number; atMs: number } | null) => {
          if (settled) return;
          settled = true;
          pingWaiters.current.delete(appMicros);
          if (timer) clearTimeout(timer);
          resolve(v);
        };
        pingWaiters.current.set(appMicros, (r) => finish(r));
        timer = setTimeout(() => finish(null), 400);
        sendV2Frame(d, buildPing(appMicros)).catch(() => finish(null));
      });
      if (got) {
        const rttMs = got.atMs - tSend;
        samples.push({ rttMs, gateUs: got.gateMicros, midPhoneMs: tSend + rttMs / 2 });
      }
      await delay(30);
    }
    const res = buildAnchor(samples);
    if (res) {
      anchorRef.current = res.anchor;
      setPing({ rttMs: res.minRttMs, offsetMs: res.anchor.g0Us / 1000 - res.anchor.p0Ms });
      pushLog(`ping minRtt=${res.minRttMs.toFixed(1)}ms (${samples.length} reply)`);
    } else {
      pushLog('ping: no replies');
    }
  }, [pushLog]);

  // ---- automatic bring-up ----------------------------------------------
  const runBringUp = useCallback(async () => {
    if (bringUpInFlight.current) return;
    if (!gateRef.current.device) return;
    bringUpInFlight.current = true;
    try {
      // 1) discovery
      setPhase('discovering');
      statusesRef.current = {};
      idToMacRef.current = {};
      const haveTwo = await waitFor(() => Object.keys(discoveredRef.current).length >= 2, 6000);
      const macs = Object.keys(discoveredRef.current).sort();
      if (!haveTwo || macs.length < 2) {
        pushLog(`bring-up: only ${macs.length} gate(s) discovered`);
        setPhase('error');
        return;
      }

      // 2) provisional assign (distinct ids so caps become correlatable)
      setPhase('assigning');
      await assign({ [START_ID]: macs[0], [FINISH_ID]: macs[1] });

      // 3) learn caps
      setPhase('syncing');
      await requestStatus();
      const gotStatus = await waitFor(
        () => statusesRef.current[START_ID] != null && statusesRef.current[FINISH_ID] != null,
        4000,
      );
      if (!gotStatus) {
        pushLog('bring-up: no STATUS_REPLY from both gates');
        setPhase('error');
        return;
      }

      // 4) role decision: has_display gate -> start (id 1), unless swapped.
      const displayIsFinish = statusesRef.current[FINISH_ID]?.hasDisplay === true;
      const displayIsStart = statusesRef.current[START_ID]?.hasDisplay === true;
      // desired: has_display gate at START, unless the user swapped roles.
      let startMac = idToMacRef.current[START_ID];
      let finishMac = idToMacRef.current[FINISH_ID];
      if (displayIsFinish && !displayIsStart) {
        [startMac, finishMac] = [finishMac, startMac]; // put the display gate at start
      }
      if (swapRef.current) [startMac, finishMac] = [finishMac, startMac];
      if (startMac !== idToMacRef.current[START_ID]) {
        statusesRef.current = {};
        await assign({ [START_ID]: startMac, [FINISH_ID]: finishMac });
        await requestStatus();
        await waitFor(
          () => statusesRef.current[START_ID] != null && statusesRef.current[FINISH_ID] != null,
          4000,
        );
      }

      // 5) fresh event queue for the session
      await sendFrame(buildClearQueue(GATE_ID_ALL));

      // 6) wait for both gates time_synced (follower converges over a few s).
      const synced = await waitFor(() => {
        const a = statusesRef.current[START_ID];
        const b = statusesRef.current[FINISH_ID];
        return !!a?.timeSynced && !!b?.timeSynced;
      }, 12000, 500);
      // keep refreshing status while waiting
      if (!synced) {
        for (let i = 0; i < 6 && !synced; i++) {
          await requestStatus();
          await delay(800);
        }
      }
      if (!statusesRef.current[START_ID]?.timeSynced || !statusesRef.current[FINISH_ID]?.timeSynced) {
        pushLog('bring-up: gates not both time_synced yet — splits withheld until they are');
      }

      // 7) display offset
      await pingSync();

      setPhase('ready');
      pushLog(`ready — start=${idToMacRef.current[START_ID]} finish=${idToMacRef.current[FINISH_ID]}`);
    } catch (e) {
      pushLog(`bring-up failed: ${String(e)}`);
      setPhase('error');
    } finally {
      bringUpInFlight.current = false;
      rebuildGates();
    }
  }, [assign, requestStatus, sendFrame, pingSync, waitFor, pushLog, rebuildGates]);

  // Auto bring-up once per connection while active; reset on disconnect.
  const connected = gate.status === 'connected';
  useEffect(() => {
    if (!active || !connected) {
      if (!connected) {
        broughtUpForConn.current = false;
        setPhase('idle');
      }
      return;
    }
    if (broughtUpForConn.current) return;
    broughtUpForConn.current = true;
    runBringUp();
  }, [active, connected, runBringUp]);

  const bringUp = useCallback(async () => {
    setActive(true);
    broughtUpForConn.current = true; // we are driving it explicitly
    await runBringUp();
  }, [runBringUp]);

  const arm = useCallback(async () => {
    engineRef.current.arm();
    setEngineState(engineRef.current.state);
    // v1 arm too, so the gate produces its result for the live comparison.
    try {
      await gateRef.current.arm1();
      pushLog('armed (v1 + v2, Mode 1)');
    } catch (e) {
      pushLog(`arm failed: ${String(e)}`);
    }
  }, [pushLog]);

  const resetEngine = useCallback(() => {
    engineRef.current.reset();
    setEngineState(engineRef.current.state);
    pendingV2.current = null;
  }, []);

  const clearComparisons = useCallback(() => setComparisons([]), []);

  const gateToPhoneMs = useCallback((gateUs: number): number | null => {
    return anchorRef.current ? gateUsToPhoneMs(gateUs, anchorRef.current) : null;
  }, []);

  const value: V2ContextValue = {
    active,
    setActive,
    phase,
    connected,
    ready: phase === 'ready',
    gates,
    swapRoles,
    setSwapRoles,
    engineState,
    lastRun,
    comparisons,
    ping,
    log,
    bringUp,
    arm,
    resetEngine,
    clearComparisons,
    gateToPhoneMs,
  };

  return <V2Context.Provider value={value}>{children}</V2Context.Provider>;
}

export function useV2(): V2ContextValue {
  const ctx = useContext(V2Context);
  if (!ctx) throw new Error('useV2 must be used within a V2Provider');
  return ctx;
}
