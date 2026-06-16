// App-wide, SQLite-backed settings exposed reactively via useSettings(), so a
// change on the calibration screen is immediately reflected on the Timer.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

import {
  DEFAULT_REACTION_OFFSET_MS,
  getMeasuredAudioLatencyMs,
  getReactionOffsetMs,
  getSetting,
  setMeasuredAudioLatencyMs as persistMeasured,
  setReactionOffsetMs as persistOffset,
  setSetting,
} from '../db/database';

// How Mode 2 reaction is corrected: 'synced' = precise per-run beep latency from
// clock sync; 'fixed' = the manual reactionOffsetMs subtraction.
export type CorrectionMode = 'synced' | 'fixed';

// One run's measured latency breakdown (all ms). bleOneway/beepLatency require a
// clock-sync anchor; null if unavailable.
export type LatencySample = {
  bleOneway: number | null;
  proc: number;
  audioGap: number;
  beepLatency: number | null;
  at: number;
};

const MAX_SAMPLES = 40;

type SettingsValue = {
  ready: boolean;
  reactionOffsetMs: number;
  measuredAudioLatencyMs: number | null;
  correctionMode: CorrectionMode;
  latencySamples: LatencySample[];
  // Developer/Advanced mode. OFF (default) hides all diagnostic/technical UI
  // (±X accuracy, clock-sync detail, raw split values, the Debug tab); the
  // underlying data is still measured and stored — this only gates display.
  devMode: boolean;
  setReactionOffsetMs: (ms: number) => void;
  setMeasuredAudioLatencyMs: (ms: number) => void;
  setCorrectionMode: (m: CorrectionMode) => void;
  addLatencySample: (s: LatencySample) => void;
  setDevMode: (on: boolean) => void;
};

const SettingsContext = createContext<SettingsValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [reactionOffsetMs, setOffset] = useState(DEFAULT_REACTION_OFFSET_MS);
  const [measuredAudioLatencyMs, setMeasured] = useState<number | null>(null);
  const [correctionMode, setMode] = useState<CorrectionMode>('synced');
  const [latencySamples, setLatencySamples] = useState<LatencySample[]>([]);
  const [devMode, setDev] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        setOffset(await getReactionOffsetMs());
        setMeasured(await getMeasuredAudioLatencyMs());
        const m = await getSetting('correction_mode');
        if (m === 'fixed' || m === 'synced') setMode(m);
        setDev((await getSetting('dev_mode')) === '1');
      } catch {
        /* keep defaults */
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const setReactionOffsetMs = useCallback((ms: number) => {
    const v = Math.max(0, Math.round(ms));
    setOffset(v);
    persistOffset(v).catch(() => {});
  }, []);

  const setMeasuredAudioLatencyMs = useCallback((ms: number) => {
    const v = Math.round(ms);
    setMeasured(v);
    persistMeasured(v).catch(() => {});
  }, []);

  const setCorrectionMode = useCallback((m: CorrectionMode) => {
    setMode(m);
    setSetting('correction_mode', m).catch(() => {});
  }, []);

  const addLatencySample = useCallback((s: LatencySample) => {
    setLatencySamples((prev) => [...prev, s].slice(-MAX_SAMPLES));
  }, []);

  const setDevMode = useCallback((on: boolean) => {
    setDev(on);
    setSetting('dev_mode', on ? '1' : '0').catch(() => {});
  }, []);

  return (
    <SettingsContext.Provider
      value={{
        ready,
        reactionOffsetMs,
        measuredAudioLatencyMs,
        correctionMode,
        latencySamples,
        devMode,
        setReactionOffsetMs,
        setMeasuredAudioLatencyMs,
        setCorrectionMode,
        addLatencySample,
        setDevMode,
      }}
    >
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within a SettingsProvider');
  return ctx;
}
