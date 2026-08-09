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
import { useSettings } from '../settings/SettingsProvider';
import { Evt } from './constants';
import { sendV2Frame } from './bleClient';
import {
  parseV2Frame,
  V2RunEngine,
  StandaloneObserver,
  buildAssignIds,
  buildGetStatus,
  buildPing,
  buildClearQueue,
  buildRunHint,
  buildSetParam,
  PARAM_SET_NUMBER,
  PARAM_RESTORE_DEFAULTS,
  type V2Frame,
  type V2Run,
  type StandaloneRun,
} from './v2';
import {
  DrillEngine,
  DRILL_L_DRILL,
  type DrillConfig,
  type DrillRun,
  type DrillState,
} from './drills';
import {
  RepeatEngine,
  REPEAT_CONTINUOUS,
  type RepeatConfig,
  type RepInterval,
  type RepSet,
  type RepeatState,
} from './repeats';
import { GATE_ID_ALL } from './v2constants';
import { buildAnchor, gateUsToPhoneMs, type ClockAnchor, type PingSample } from './clockSync';
import { saveRun } from '../db/database';
import type { LastResult } from './events';

const perfNow = () =>
  typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now();
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const START_ID = 1;
const FINISH_ID = 2;

function macStrToBytes(mac: string): Uint8Array {
  return Uint8Array.from(mac.split(':').map((h) => parseInt(h, 16)));
}

// 'partial' = connected with FEWER than two live gates — a legitimate state
// (single-gate recovery, or waiting for the second gate to power on), NOT an
// error. Bring-up re-runs automatically when another gate appears.
export type V2Phase = 'idle' | 'discovering' | 'assigning' | 'syncing' | 'ready' | 'partial' | 'error';

export type GateView = {
  id: number | null;
  mac: string;
  role: 'start' | 'finish' | null;
  hasDisplay: boolean;
  timeSynced: boolean;
  thresholdCm: number;
  /** g1+: active radio set (1–3); 0 = f2 firmware without sets. */
  setNumber: number;
  /** g1+: a persisted set change awaits a power cycle. */
  rebootPending: boolean;
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
  setNumber: number;
  rebootPending: boolean;
};

export type V2ContextValue = {
  active: boolean;
  // Ref-counted activation: each consumer (Timer, Lab) retains on mount and
  // releases on unmount. The session is dormant (no subscription, no commands)
  // while the count is 0, so v1-default users are untouched.
  retain: () => void;
  release: () => void;
  phase: V2Phase;
  connected: boolean;
  ready: boolean;
  gates: GateView[];
  swapRoles: boolean;
  setSwapRoles: (b: boolean) => void;
  engineState: string;
  running: { startUs: number; startAtMs: number } | null;
  lastRun: V2Run | null;
  comparisons: Comparison[];
  ping: { rttMs: number; offsetMs: number } | null;
  log: string[];
  bringUp: () => Promise<void>;
  arm: () => Promise<void>;
  armCompare: () => Promise<void>;
  resetEngine: () => void;
  clearComparisons: () => void;
  gateToPhoneMs: (gateUs: number) => number | null;
  // Drills (app-owned parameterized engine; firmware untouched). setDrill keeps
  // the engine's config current (so start-beam tracking uses the right gates)
  // BEFORE arming; armDrill arms with the given config; cancelDrill resets.
  drillState: DrillState;
  drillRunning: { startUs: number; startAtMs: number } | null;
  drillProgress: { counted: number; countN: number } | null;
  lastDrillRun: DrillRun | null;
  setDrill: (config: DrillConfig) => void;
  armDrill: (config: DrillConfig) => void;
  cancelDrill: () => void;
  // Rep sets (single-gate interval timing, src/ble/repeats.ts). Both gates stay
  // paired as normal; the engine simply ignores every frame from the gate it is
  // not timing, so this needs no partial bring-up and no set-splitting.
  repeatState: RepeatState;
  /** intervals collected SO FAR — nothing is stored until endRepeat(). */
  repeatIntervals: RepInterval[];
  /** the finished set, awaiting review-and-save on the screen. */
  lastRepSet: RepSet | null;
  armRepeat: (config: RepeatConfig) => void;
  /** REST variant only: the coach taps, the athlete goes. */
  startRep: () => void;
  /** Explicit end — never a timeout. One gate cannot tell finishing a lap from
   *  walking back through the beam, so the coach says when the set is over. */
  endRepeat: () => void;
  cancelRepeat: () => void;
  clearLastRepSet: () => void;
  /** Most recent reconstructed standalone (B1) run — only produced when the
   *  logStandalone setting is on. The screen that owns saving reads this. */
  lastStandaloneRun: StandaloneRun | null;
  /** g1 sets (SETS-G1 §4): persist SET_NUMBER on both gates, confirm via
   *  STATUS_REPLY reboot_pending, then instruct a power-cycle. In RECOVERY
   *  (single gate, no ready session) it acks against however many gates reply. */
  changeSet: (n: number) => Promise<void>;
  /** Recovery: RESTORE_DEFAULTS on all reachable gates (Set 1 on next boot). */
  restoreDefaults: () => Promise<void>;
};

const V2Context = createContext<V2ContextValue | null>(null);

export function V2Provider({ children }: { children: ReactNode }) {
  const gate = useGate();
  const { logStandalone } = useSettings();
  const engineRef = useRef(new V2RunEngine(START_ID, FINISH_ID));
  const drillRef = useRef(new DrillEngine(DRILL_L_DRILL));
  const repeatRef = useRef(new RepeatEngine(REPEAT_CONTINUOUS));
  const observerRef = useRef(new StandaloneObserver());
  // Live mirror of the opt-in flag so the event-stream closure reads it fresh.
  const logStandaloneRef = useRef(logStandalone);
  logStandaloneRef.current = logStandalone;
  // Drops a standalone-observer arm that never completes (stray B1, no run).
  const saTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [activeCount, setActiveCount] = useState(0);
  const active = activeCount > 0;
  const retain = useCallback(() => setActiveCount((c) => c + 1), []);
  const release = useCallback(() => setActiveCount((c) => Math.max(0, c - 1)), []);
  const [phase, setPhase] = useState<V2Phase>('idle');
  const [swapRoles, setSwapRoles] = useState(false);
  const [engineState, setEngineState] = useState<string>(engineRef.current.state);
  const [lastRun, setLastRun] = useState<V2Run | null>(null);
  const [comparisons, setComparisons] = useState<Comparison[]>([]);
  const [ping, setPing] = useState<{ rttMs: number; offsetMs: number } | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [gates, setGates] = useState<GateView[]>([]);
  const [running, setRunning] = useState<{ startUs: number; startAtMs: number } | null>(null);
  const [drillState, setDrillState] = useState<DrillState>('idle');
  const [drillRunning, setDrillRunning] = useState<{ startUs: number; startAtMs: number } | null>(
    null,
  );
  const [drillProgress, setDrillProgress] = useState<{ counted: number; countN: number } | null>(
    null,
  );
  const [lastDrillRun, setLastDrillRun] = useState<DrillRun | null>(null);
  const [lastStandaloneRun, setLastStandaloneRun] = useState<StandaloneRun | null>(null);
  const [repeatState, setRepeatState] = useState<RepeatState>('idle');
  const [repeatIntervals, setRepeatIntervals] = useState<RepInterval[]>([]);
  const [lastRepSet, setLastRepSet] = useState<RepSet | null>(null);

  // Live mirrors (refs) so the async bring-up reads current values, not stale.
  const discoveredRef = useRef<Record<string, number>>({}); // mac -> lastSeenMs
  const hbSetRef = useRef<Record<string, number | null>>({}); // mac -> heartbeat set tag (g1-a2+)
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
  const expectV1Ref = useRef(false); // pair against v1 LastResult? (Lab comparison only)
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
        setNumber: s?.setNumber ?? hbSetRef.current[mac] ?? 0,
        rebootPending: s?.rebootPending ?? false,
      });
    }
    // Any discovered-but-unassigned gates (pre-bring-up / recovery). The set
    // comes from the heartbeat tag, so a stranded gate's set shows immediately.
    for (const mac of Object.keys(discoveredRef.current)) {
      if (seen.has(mac)) continue;
      out.push({
        id: null, mac, role: null, hasDisplay: false, timeSynced: false,
        thresholdCm: 0, setNumber: hbSetRef.current[mac] ?? 0, rebootPending: false,
      });
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

    engine.onStart = (startUs, startAtMs) => {
      setRunning({ startUs, startAtMs });
      setEngineState(engine.state);
    };

    engine.onRun = (run) => {
      setRunning(null);
      setLastRun(run);
      setEngineState(engine.state);
      // NO disarm hint here: the gate's mirror is in RESULT showing the split —
      // the readout for whoever is at the finish gate. Firmware auto-clears a
      // mirror result after ~4s; arm() clears any leftover before the next rep.
      pushLog(`v2 run split=${run.splitMs}ms${run.synced ? '' : ' (unsynced — withheld)'}`);
      if (!expectV1Ref.current) return; // Timer path: no v1 comparison
      runToken.current += 1;
      const token = runToken.current;
      pendingV2.current = { splitMs: run.splitMs, synced: run.synced, atMs: run.finishAtMs, token };
      setTimeout(() => pairViaLastResult(token, 0), 450);
    };

    // Drills (app-owned parameterized engine) — same event stream, own state.
    const drill = drillRef.current;
    drill.onStart = (startUs, startAtMs) => {
      setDrillRunning({ startUs, startAtMs });
      setDrillProgress({ counted: 0, countN: drill.config.countN });
      setDrillState(drill.state);
    };
    drill.onCount = (counted, countN) => setDrillProgress({ counted, countN });
    drill.onRun = (run) => {
      setDrillRunning(null);
      setLastDrillRun(run);
      setDrillState(drill.state);
      pushLog(`drill ${run.label}: ${run.splitMs}ms${run.synced ? '' : ' (unsynced — withheld)'}`);
    };

    // Rep sets — single gate, open-ended, ended by a button not a frame.
    const repeat = repeatRef.current;
    repeat.onOpen = () => setRepeatState(repeat.state);
    repeat.onInterval = (interval, count) =>
      pushLog(`rep ${count}: ${interval.ms}ms (${interval.startSource}-started)`);

    // Standalone (B1) observer — passive; only arms on a button press when opted
    // in and all app engines are idle (see the 'button' case below).
    const observer = observerRef.current;
    observer.onRun = (run) => {
      setLastStandaloneRun(run);
      if (!run.synced) {
        pushLog(`standalone run withheld (gates not synced)`);
        return;
      }
      // Saved centrally (not per-screen): a B1 run can happen on any tab. Mode 1,
      // no tags; rawJson marks the source so it's distinguishable in History.
      //
      // Deliberately UNASSIGNED, and deliberately does NOT advance the queue:
      // nobody was driving the phone during a B1 run, so the current athlete may
      // be twenty minutes stale. A plausible wrong name is worse than a blank —
      // a blank prompts a fix in History, a wrong name never gets questioned.
      pushLog(`standalone run: ${run.splitMs}ms (gate ${run.startGateId}→${run.finishGateId})`);
      saveRun({
        mode: 1,
        totalMs: run.splitMs,
        split1Ms: 0,
        split2Ms: 0,
        status: 'valid',
        rawJson: JSON.stringify({
          engine: 'v2',
          source: 'standalone',
          startGateId: run.startGateId,
          finishGateId: run.finishGateId,
          startUs: run.startUs,
          finishUs: run.finishUs,
          splitMs: run.splitMs,
          synced: run.synced,
        }),
        drillType: 'Standalone',
      }).catch((e) => pushLog(`standalone save failed: ${String(e)}`));
    };

    const off = gate.subscribe((raw, parsed, atMs) => {
      if (expectV1Ref.current && parsed && parsed.type === Evt.Finish) {
        pairV1(parsed.totalMs, atMs, 'FINISH');
      }
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
          hbSetRef.current[f.mac] = f.setNumber; // g1-a2 heartbeats claim their set
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
            setNumber: f.caps.setNumber,
            rebootPending: f.caps.rebootPending,
          };
          engine.setSynced(f.gateId, f.caps.timeSynced);
          drill.setSynced(f.gateId, f.caps.timeSynced);
          observer.setSynced(f.gateId, f.caps.timeSynced);
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
          // Drills need BOTH edges (start on a CLEAR); the observer ignores clears.
          drill.ingest(f, atMs);
          setDrillState(drill.state);
          // Rep sets: only BREAKs on the timed gate matter, so gate 2 crossings
          // fall through untouched even though it is connected and advertising.
          if (repeat.ingest(f, atMs)) setRepeatIntervals([...repeat.intervals]);
          setRepeatState(repeat.state);
          observer.onBeam(f.edge, f.gateId, f.micros, atMs);
          break;
        case 'button':
          // A gate button (B1/B2) was pressed. If opted in AND no app-driven run
          // is active, observe a standalone Mode-1 run; re-arms on each press and
          // self-drops after a window if no run completes (stray press).
          if (
            logStandaloneRef.current &&
            engine.state === 'idle' &&
            drill.state === 'idle' &&
            repeat.state === 'idle'
          ) {
            observer.arm();
            if (saTimerRef.current) clearTimeout(saTimerRef.current);
            saTimerRef.current = setTimeout(() => observer.reset(), 35000);
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

  // Only gates HEARD RECENTLY count. Heartbeats arrive every 1-5s, so a gate
  // silent >12s is stale — without this, a gate discovered once and then powered
  // off still "exists" and bring-up can assign an id to a corpse (or, with 3+
  // gates ever seen, pick a dead one over a live one by MAC order).
  const liveMacs = useCallback(() => {
    const now = perfNow();
    return Object.keys(discoveredRef.current).filter((m) => now - discoveredRef.current[m] < 12000);
  }, []);

  // ---- automatic bring-up ----------------------------------------------
  const runBringUp = useCallback(async () => {
    if (bringUpInFlight.current) return;
    if (!gateRef.current.device) return;
    bringUpInFlight.current = true;
    try {
      // 1) discovery — LIVE gates only
      setPhase('discovering');
      statusesRef.current = {};
      idToMacRef.current = {};
      const haveTwo = await waitFor(() => liveMacs().length >= 2, 6000);
      const macs = liveMacs().sort();
      if (!haveTwo || macs.length < 2) {
        // Not an error: single-gate recovery / second gate not powered yet.
        // Pull whatever status we can for the recovery UI; the discovery
        // effect re-runs bring-up automatically when another gate appears.
        pushLog(`bring-up: ${macs.length} gate(s) live — partial (recovery available)`);
        await requestStatus();
        setPhase('partial');
        return;
      }
      if (macs.length > 2) {
        pushLog(`${macs.length} gates live on this set — timing uses ${macs[0]} & ${macs[1]}`);
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
  }, [assign, requestStatus, sendFrame, pingSync, waitFor, pushLog, rebuildGates, liveMacs]);

  // Auto bring-up once per connection while active; FULL reset on disconnect —
  // every latch cleared (discovery, sets, statuses, ids, clock anchor, engine),
  // so a reconnect rebuilds from live truth instead of stale state.
  const connected = gate.status === 'connected';
  useEffect(() => {
    if (!active || !connected) {
      if (!connected) {
        broughtUpForConn.current = false;
        discoveredRef.current = {};
        hbSetRef.current = {};
        statusesRef.current = {};
        idToMacRef.current = {};
        anchorRef.current = null;
        setPing(null);
        setGates([]);
        engineRef.current.reset();
        setEngineState(engineRef.current.state);
        setRunning(null);
        // Drill + standalone engines reset on disconnect too (no latched state
        // survives a link loss); last results are kept for display, like Mode 1.
        drillRef.current.reset();
        observerRef.current.reset();
        if (saTimerRef.current) clearTimeout(saTimerRef.current);
        setDrillState('idle');
        setDrillRunning(null);
        setDrillProgress(null);
        setPhase('idle');
      }
      return;
    }
    if (broughtUpForConn.current) return;
    broughtUpForConn.current = true;
    runBringUp();
  }, [active, connected, runBringUp]);

  // Re-assembly: whenever discovery changes (gates list rebuilds on every
  // heartbeat) and we're sitting in 'partial'/'error' with two live gates now
  // visible, re-run bring-up. Kills the order-dependence: power gates in any
  // order, connect whenever — the session assembles itself when possible.
  useEffect(() => {
    if (!active || !connected) return;
    if (phase !== 'partial' && phase !== 'error') return;
    if (bringUpInFlight.current) return;
    if (liveMacs().length >= 2) {
      pushLog('second gate appeared — re-running bring-up');
      runBringUp();
    }
  }, [gates, phase, active, connected, runBringUp, liveMacs, pushLog]);

  const bringUp = useCallback(async () => {
    broughtUpForConn.current = true; // we are driving it explicitly
    await runBringUp();
  }, [runBringUp]);

  // v2-only arm (Timer). No gate command needed — v2 gates emit edges always;
  // arming is purely the app-side engine waiting for the start-gate break.
  const arm = useCallback(async () => {
    expectV1Ref.current = false;
    setRunning(null);
    // At most ONE app engine armed at a time: a Mode-1 arm cancels any lingering
    // drill arm (and the standalone watch), so a forgotten arm can't later fire.
    observerRef.current.reset();
    drillRef.current.reset();
    setDrillState('idle');
    setDrillRunning(null);
    setDrillProgress(null);
    engineRef.current.arm();
    setEngineState(engineRef.current.state);
    // Display-only mirror hints (RUN_HINT 0x37), clear-then-arm IN ORDER: the
    // gate only mirror-arms from READY, so a re-arm inside the ~4s mirror-RESULT
    // window needs the clear first or the arm hint is dropped (rep won't mirror).
    // The clear can never touch a real B1/B2 standalone run (§8.2).
    sendFrame(buildRunHint(GATE_ID_ALL, false))
      .then(() => sendFrame(buildRunHint(GATE_ID_ALL, true)))
      .catch(() => {});
    pushLog('armed (v2, Mode 1)');
  }, [pushLog, sendFrame]);

  // Lab/acceptance arm: also arm v1 (arm1) so the gate produces its result to
  // pair against, and enable the LastResult comparison for this run.
  const armCompare = useCallback(async () => {
    expectV1Ref.current = true;
    setRunning(null);
    observerRef.current.reset();
    drillRef.current.reset();
    setDrillState('idle');
    setDrillRunning(null);
    setDrillProgress(null);
    engineRef.current.arm();
    setEngineState(engineRef.current.state);
    sendFrame(buildRunHint(GATE_ID_ALL, false)) // clear-then-arm, same as arm()
      .then(() => sendFrame(buildRunHint(GATE_ID_ALL, true)))
      .catch(() => {});
    try {
      await gateRef.current.arm1();
      pushLog('armed (v1 + v2, Mode 1)');
    } catch (e) {
      pushLog(`arm failed: ${String(e)}`);
    }
  }, [pushLog, sendFrame]);

  const resetEngine = useCallback(() => {
    engineRef.current.reset();
    setEngineState(engineRef.current.state);
    setRunning(null);
    pendingV2.current = null;
    // Clear any mirror-arm on the gates (display-only).
    sendFrame(buildRunHint(GATE_ID_ALL, false)).catch(() => {});
  }, [sendFrame]);

  // ---- drills (app-owned parameterized engine) --------------------------
  // No gate command: v2 gates emit edges always, so a drill is purely the app-
  // side engine interpreting them (no RUN_HINT — the gate stays on its idle/
  // standalone screen; all drill UI is on the phone).
  const setDrill = useCallback((config: DrillConfig) => {
    drillRef.current.setConfig(config);
  }, []);

  const armDrill = useCallback(
    (config: DrillConfig) => {
      // Supersede the standalone watch AND any Mode-1 arm (mutual exclusion).
      observerRef.current.reset();
      engineRef.current.reset();
      setEngineState(engineRef.current.state);
      setRunning(null);
      drillRef.current.setConfig(config);
      drillRef.current.arm();
      setDrillState(drillRef.current.state);
      setDrillRunning(null);
      setDrillProgress(null);
      pushLog(`drill armed: ${config.label} (lockout ${config.lockoutMs}ms)`);
    },
    [pushLog],
  );

  const cancelDrill = useCallback(() => {
    drillRef.current.reset();
    setDrillState(drillRef.current.state);
    setDrillRunning(null);
    setDrillProgress(null);
  }, []);

  // --- rep sets -------------------------------------------------------------
  const armRepeat = useCallback(
    (config: RepeatConfig) => {
      // Same mutual exclusion the drills use: one timing engine owns the gates.
      observerRef.current.reset();
      engineRef.current.reset();
      setEngineState(engineRef.current.state);
      setRunning(null);
      drillRef.current.reset();
      setDrillState(drillRef.current.state);
      setLastRepSet(null);
      repeatRef.current.reset();
      repeatRef.current.setConfig(config);
      repeatRef.current.arm(Date.now());
      setRepeatState(repeatRef.current.state);
      setRepeatIntervals([]);
      pushLog(`rep set armed: ${config.title} on gate ${config.gateId} (lockout ${config.lockoutMs}ms)`);
    },
    [pushLog],
  );

  const startRep = useCallback(() => {
    repeatRef.current.startRep(Date.now());
    setRepeatState(repeatRef.current.state);
  }, []);

  const endRepeat = useCallback(() => {
    if (repeatRef.current.state === 'idle') return;
    const set = repeatRef.current.end(Date.now());
    setRepeatState(repeatRef.current.state);
    setRepeatIntervals([]);
    setLastRepSet(set);
    pushLog(`rep set ended: ${set.intervals.length} interval(s), total ${set.totalMs}ms`);
  }, [pushLog]);

  const cancelRepeat = useCallback(() => {
    repeatRef.current.reset();
    setRepeatState(repeatRef.current.state);
    setRepeatIntervals([]);
  }, []);

  const clearLastRepSet = useCallback(() => setLastRepSet(null), []);

  const clearComparisons = useCallback(() => setComparisons([]), []);

  const gateToPhoneMs = useCallback((gateUs: number): number | null => {
    return anchorRef.current ? gateUsToPhoneMs(gateUs, anchorRef.current) : null;
  }, []);

  // g1 set change, closed loop (SETS-G1 §4): SET_PARAM(SET_NUMBER, all gates,
  // always-persist on the gate side) → fresh GET_STATUS → both gates must show
  // either reboot_pending (new set persisted) or already-active-on-n. Command
  // relay is single-shot, so this ack IS the reliability mechanism — a missing
  // ack means retry, not hope. Apply = power-cycle both gates (reboot-to-apply).
  const changeSet = useCallback(
    async (n: number) => {
      // Normal session: expect BOTH gates to ack. RECOVERY (no ready session —
      // e.g. a solitary gate stranded on the wrong set): ack against however
      // many gates actually reply (>=1). This is the phone path that rescues a
      // bare gate (no buttons, no display) — see SETS-G1 §4.
      const expected = phase === 'ready' ? 2 : 1;
      pushLog(`set → ${n}: writing (persist, all gates)…`);
      try {
        await sendFrame(buildSetParam(GATE_ID_ALL, PARAM_SET_NUMBER, n, true));
        await delay(300); // relay + NVS commit
        statusesRef.current = {};
        await sendFrame(buildGetStatus(GATE_ID_ALL));
        const acked = (s: StatusView) => (s.setNumber === n ? !s.rebootPending : s.rebootPending);
        const ok = await waitFor(() => {
          const sts = Object.values(statusesRef.current);
          return sts.length >= expected && sts.every(acked);
        }, 2500);
        rebuildGates();
        const got = Object.values(statusesRef.current).length;
        if (ok) pushLog(`Set ${n} persisted on ${got} gate(s) — power-cycle to apply`);
        else pushLog(`Set ${n}: acked by ${got}/${expected} — retry (f2 firmware has no sets)`);
      } catch (e) {
        pushLog(`set change failed: ${String(e)}`);
      }
    },
    [phase, sendFrame, waitFor, pushLog, rebuildGates],
  );

  // Recovery: restore ALL params to defaults on every reachable gate — NVS
  // cleared, Set 1 on next boot. The BLE-side twin of the B1-at-boot escape,
  // and the only recovery a bare (buttonless) gate has.
  const restoreDefaults = useCallback(async () => {
    pushLog('restore defaults: writing (all gates)…');
    try {
      await sendFrame(buildSetParam(GATE_ID_ALL, PARAM_RESTORE_DEFAULTS, 0, false));
      await delay(300);
      statusesRef.current = {};
      await sendFrame(buildGetStatus(GATE_ID_ALL));
      await waitFor(() => Object.keys(statusesRef.current).length >= 1, 2000);
      rebuildGates();
      const got = Object.values(statusesRef.current).length;
      pushLog(`defaults restored on ${got} gate(s) (Set 1 next boot) — power-cycle`);
    } catch (e) {
      pushLog(`restore failed: ${String(e)}`);
    }
  }, [sendFrame, waitFor, pushLog, rebuildGates]);

  const value: V2ContextValue = {
    active,
    retain,
    release,
    phase,
    connected,
    ready: phase === 'ready',
    gates,
    swapRoles,
    setSwapRoles,
    engineState,
    running,
    lastRun,
    comparisons,
    ping,
    log,
    bringUp,
    arm,
    armCompare,
    resetEngine,
    clearComparisons,
    gateToPhoneMs,
    drillState,
    drillRunning,
    drillProgress,
    lastDrillRun,
    setDrill,
    armDrill,
    cancelDrill,
    repeatState,
    repeatIntervals,
    lastRepSet,
    armRepeat,
    startRep,
    endRepeat,
    cancelRepeat,
    clearLastRepSet,
    lastStandaloneRun,
    changeSet,
    restoreDefaults,
  };

  return <V2Context.Provider value={value}>{children}</V2Context.Provider>;
}

export function useV2(): V2ContextValue {
  const ctx = useContext(V2Context);
  if (!ctx) throw new Error('useV2 must be used within a V2Provider');
  return ctx;
}
