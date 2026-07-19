// Dev-only v2 pipeline controller (behind the Debug tab). Rides the shared
// GateProvider BLE connection: it parses v2 frames off the SAME Event stream the
// v1 pipeline uses, runs the app-owned Mode-1 engine, and pairs each v2 split
// with the v1 FINISH for the same physical run so we can watch them agree
// (docs/BLE-CONTRACT.md §14 acceptance test). Nothing here runs unless the
// Debug/v2-Lab view is mounted, and it only sends commands on explicit taps, so
// the default app experience and the live v1 timer are untouched.

import { useCallback, useEffect, useRef, useState } from 'react';

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
import type { LastResult } from './events';

const perfNow = () =>
  typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now();
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// This 2-gate product's known MACs (from firmware/README.md). App-owned mapping:
// start gate = id 1, finish gate = id 2. Mirrors the firmware peer pairing.
const GATE1_MAC = Uint8Array.from([0xb4, 0xbf, 0xe9, 0x32, 0xda, 0x64]); // start
const GATE2_MAC = Uint8Array.from([0x30, 0x76, 0xf5, 0xa6, 0x43, 0xbc]); // finish
const GATE1_MAC_STR = 'b4:bf:e9:32:da:64';
const GATE2_MAC_STR = '30:76:f5:a6:43:bc';
const KNOWN_ID: Record<string, number> = { [GATE1_MAC_STR]: 1, [GATE2_MAC_STR]: 2 };

export type DiscoveredGate = { mac: string; gateId: number | null; lastSeenMs: number };
export type V2StatusView = {
  gateId: number;
  thresholdCm: number;
  queueDepth: number;
  fwVer: number;
  timeSynced: boolean;
  hasDisplay: boolean;
  hasButtons: boolean;
  buzzerWired: boolean;
};
export type Comparison = {
  id: string;
  atMs: number;
  v1Ms: number;
  v2Ms: number;
  deltaMs: number;
  synced: boolean;
};

export type V2Pipeline = {
  connected: boolean;
  discovered: DiscoveredGate[];
  statuses: V2StatusView[];
  engineState: string;
  lastRun: V2Run | null;
  comparisons: Comparison[];
  ping: { rttMs: number; offsetMs: number } | null;
  busy: string | null;
  log: string[];
  assignIds: () => Promise<void>;
  getStatus: () => Promise<void>;
  pingSync: () => Promise<void>;
  clearQueue: () => Promise<void>;
  armRun: () => Promise<void>;
  resetEngine: () => void;
  clearComparisons: () => void;
};

export function useV2Pipeline(): V2Pipeline {
  const gate = useGate();
  const engineRef = useRef(new V2RunEngine(1, 2));

  const [discovered, setDiscovered] = useState<Record<string, DiscoveredGate>>({});
  const [statuses, setStatuses] = useState<Record<number, V2StatusView>>({});
  const [engineState, setEngineState] = useState<string>(engineRef.current.state);
  const [lastRun, setLastRun] = useState<V2Run | null>(null);
  const [comparisons, setComparisons] = useState<Comparison[]>([]);
  const [ping, setPing] = useState<{ rttMs: number; offsetMs: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);

  // Pairing state (refs so the stream handler never reads stale values). We pair
  // the v2 run against the v1 result; the v1 FINISH *notification* drops ~100% on
  // this hardware, so the reliable path is the LastResult read keyed by runIndex.
  const pendingV2 = useRef<{ splitMs: number; synced: boolean; atMs: number; token: number } | null>(
    null,
  );
  const runToken = useRef(0); // tags each v2 run so a stale fallback can't pair a newer run
  const lastPairedRunIndex = useRef(-1); // v1 LastResult.runIndex already consumed
  const cmpSeq = useRef(0);
  // De-dupe raw events by (type, gate_id, micros): the same physical edge is
  // delivered twice (live notify + queue drain). micros is the capture instant,
  // so an identical key is definitionally the same edge, not two crossings.
  const recentKeys = useRef<Set<string>>(new Set());
  const recentKeyOrder = useRef<string[]>([]);
  // Always-latest gate handle, for timers/closures that must not re-subscribe.
  const gateRef = useRef(gate);
  gateRef.current = gate;
  // Outstanding PING requests keyed by the echoed app_micros.
  const pingWaiters = useRef<Map<number, (r: { gateMicros: number; atMs: number }) => void>>(
    new Map(),
  );
  const pingCounter = useRef(1);

  const pushLog = useCallback((msg: string) => {
    const t = new Date().toLocaleTimeString();
    setLog((prev) => [`${t}  ${msg}`, ...prev].slice(0, 200));
  }, []);

  // Wire the engine + event stream ONCE (subscribe is stable across renders).
  useEffect(() => {
    const engine = engineRef.current;

    const emitComparison = (
      v1Ms: number,
      v2: { splitMs: number; synced: boolean },
      atMs: number,
    ) => {
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
      pushLog(
        `compare v1=${v1Ms}ms v2=${v2.synced ? v2.splitMs : '—'}ms Δ=${v2.synced ? c.deltaMs : '—'}ms`,
      );
    };

    // Pair the pending v2 run with a v1 total. Returns whether it paired.
    const pairV1 = (v1Ms: number, atMs: number, source: string): boolean => {
      const v2 = pendingV2.current;
      if (!v2) return false;
      if (Math.abs(atMs - v2.atMs) > 5000) return false; // not the same rep
      pendingV2.current = null;
      emitComparison(v1Ms, v2, Math.max(atMs, v2.atMs));
      pushLog(`paired via ${source}`);
      return true;
    };

    // The real pairing path here: FINISH notifications drop ~100%, so a few
    // hundred ms after the v2 run completes we read the RELIABLE LastResult (the
    // same recovery the Timer uses) and pair by its runIndex. Token-guarded so a
    // late retry can never pair a newer run; runIndex-guarded so a pre-run read
    // can't pair a stale result.
    const pairViaLastResult = async (token: number, attempt: number) => {
      const cur = pendingV2.current;
      if (!cur || cur.token !== token) return; // already paired, or superseded
      let lr: LastResult | null = null;
      try {
        lr = await gateRef.current.readLastResultNow();
      } catch {
        /* read failed; fall through to retry */
      }
      if (!pendingV2.current || pendingV2.current.token !== token) return;
      if (lr && lr.runIndex !== lastPairedRunIndex.current) {
        lastPairedRunIndex.current = lr.runIndex;
        pairV1(lr.totalMs, perfNow(), `LastResult run#${lr.runIndex}`);
        return;
      }
      if (attempt < 4) {
        setTimeout(() => pairViaLastResult(token, attempt + 1), 400);
      } else {
        pushLog('no v1 result for this rep (LastResult never advanced)');
      }
    };

    engine.onRun = (run) => {
      setLastRun(run);
      setEngineState(engine.state);
      runToken.current += 1;
      const token = runToken.current;
      pendingV2.current = { splitMs: run.splitMs, synced: run.synced, atMs: run.finishAtMs, token };
      pushLog(`v2 run split=${run.splitMs}ms${run.synced ? '' : ' (unsynced — withheld)'}`);
      // FINISH may pair it first (fast path); otherwise LastResult picks it up.
      setTimeout(() => pairViaLastResult(token, 0), 450);
    };

    const off = gate.subscribe((raw, parsed, atMs) => {
      // v1 fast path: a Mode-1 FINISH total == the g1→g2 split. Usually dropped
      // on this hardware; pairs the pending v2 run directly when it does arrive.
      if (parsed && parsed.type === Evt.Finish) {
        pairV1(parsed.totalMs, atMs, 'FINISH');
      }
      const f: V2Frame | null = parseV2Frame(raw);
      if (!f) return;
      // De-dupe duplicate delivery of the same physical edge (live + queue drain).
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
          setDiscovered((prev) => {
            const prevGate = prev[f.mac];
            return {
              ...prev,
              [f.mac]: {
                mac: f.mac,
                gateId: prevGate?.gateId ?? KNOWN_ID[f.mac] ?? null,
                lastSeenMs: atMs,
              },
            };
          });
          break;
        case 'status':
          setStatuses((prev) => ({
            ...prev,
            [f.gateId]: {
              gateId: f.gateId,
              thresholdCm: f.thresholdCm,
              queueDepth: f.queueDepth,
              fwVer: f.fwVer,
              timeSynced: f.caps.timeSynced,
              hasDisplay: f.caps.hasDisplay,
              hasButtons: f.caps.hasButtons,
              buzzerWired: f.caps.buzzerWired,
            },
          }));
          engine.setSynced(f.gateId, f.caps.timeSynced);
          pushLog(`status g${f.gateId} synced=${f.caps.timeSynced} thr=${f.thresholdCm}cm q=${f.queueDepth}`);
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
            engine.onBeamBreak(f.gateId, f.micros, atMs); // completion fires engine.onRun
            setEngineState(engine.state);
          }
          // Log BOTH edges: the detector requires a CLEAR before the next BREAK,
          // so logging only breaks made hand-wave chatter look like back-to-back
          // breaks. Seeing the alternation confirms debounce is holding.
          pushLog(`BEAM_${f.edge === 'break' ? 'BREAK' : 'CLEAR'} g${f.gateId} @${f.micros}us`);
          break;
        case 'buzzer':
          pushLog(`BUZZER_FIRED g${f.gateId} @${f.micros}us`);
          break;
        case 'button':
          pushLog(`BUTTON_PRESS g${f.gateId}`);
          break;
      }
    });
    return off;
  }, [gate.subscribe, pushLog]);

  const sendFrame = useCallback(
    async (bytes: Uint8Array) => {
      const d = gate.device;
      if (!d) throw new Error('not connected');
      await sendV2Frame(d, bytes);
    },
    [gate.device],
  );

  // Assign the known MACs to ids 1/2. ESP-NOW is unacked, so re-send a couple
  // times, then poll status to confirm the remote gate took its id.
  const assignIds = useCallback(async () => {
    setBusy('assign');
    try {
      const frame = buildAssignIds([
        { mac: GATE1_MAC, id: 1 },
        { mac: GATE2_MAC, id: 2 },
      ]);
      await sendFrame(frame);
      await delay(150);
      await sendFrame(frame);
      setDiscovered((prev) => {
        const next = { ...prev };
        for (const mac of Object.keys(next)) {
          const id = KNOWN_ID[mac];
          if (id) next[mac] = { ...next[mac], gateId: id };
        }
        return next;
      });
      pushLog('sent ASSIGN_IDS (g1→1, g2→2)');
      await delay(200);
      await sendFrame(buildGetStatus(GATE_ID_ALL));
    } catch (e) {
      pushLog(`assign failed: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  }, [sendFrame, pushLog]);

  const getStatus = useCallback(async () => {
    setBusy('status');
    try {
      await sendFrame(buildGetStatus(GATE_ID_ALL));
      pushLog('sent GET_STATUS (all)');
    } catch (e) {
      pushLog(`status failed: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  }, [sendFrame, pushLog]);

  const clearQueue = useCallback(async () => {
    setBusy('clear');
    try {
      await sendFrame(buildClearQueue(GATE_ID_ALL));
      pushLog('sent CLEAR_QUEUE (all)');
    } catch (e) {
      pushLog(`clear failed: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  }, [sendFrame, pushLog]);

  // PING/PING_REPLY on the Event channel: min-RTT sample sets the display offset
  // (gate µs → phone ms). Does not affect any recorded split (those are gate-clock
  // differences); this only proves the reply path and drives a running timer.
  const pingSync = useCallback(async () => {
    const d = gate.device;
    if (!d) return;
    setBusy('ping');
    const samples: { rttMs: number; gateMicros: number; midMs: number }[] = [];
    try {
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
          samples.push({ rttMs, gateMicros: got.gateMicros, midMs: tSend + rttMs / 2 });
        }
        await delay(30);
      }
      if (samples.length) {
        samples.sort((a, b) => a.rttMs - b.rttMs);
        const best = samples[0];
        const offsetMs = best.gateMicros / 1000 - best.midMs; // gate − phone
        setPing({ rttMs: best.rttMs, offsetMs });
        pushLog(`ping: ${samples.length} reply, minRtt=${best.rttMs.toFixed(1)}ms`);
      } else {
        pushLog('ping: no replies');
      }
    } finally {
      setBusy(null);
    }
  }, [gate.device, pushLog]);

  // Arm BOTH pipelines for a Mode-1 rep: v1 (arm1) so the gate computes its
  // result, and the v2 engine so it pairs the raw-edge split against it.
  const armRun = useCallback(async () => {
    engineRef.current.arm();
    setEngineState(engineRef.current.state);
    try {
      await gate.arm1();
      pushLog('armed v1 + v2 (Mode 1)');
    } catch (e) {
      pushLog(`arm failed: ${String(e)}`);
    }
  }, [gate, pushLog]);

  const resetEngine = useCallback(() => {
    engineRef.current.reset();
    setEngineState(engineRef.current.state);
    pendingV2.current = null;
  }, []);

  const clearComparisons = useCallback(() => setComparisons([]), []);

  return {
    connected: gate.status === 'connected',
    discovered: Object.values(discovered).sort((a, b) => (a.gateId ?? 99) - (b.gateId ?? 99)),
    statuses: Object.values(statuses).sort((a, b) => a.gateId - b.gateId),
    engineState,
    lastRun,
    comparisons,
    ping,
    busy,
    log,
    assignIds,
    getStatus,
    pingSync,
    clearQueue,
    armRun,
    resetEngine,
    clearComparisons,
  };
}
