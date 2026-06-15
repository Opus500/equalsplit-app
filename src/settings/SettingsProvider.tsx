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
  setMeasuredAudioLatencyMs as persistMeasured,
  setReactionOffsetMs as persistOffset,
} from '../db/database';

type SettingsValue = {
  ready: boolean;
  reactionOffsetMs: number;
  measuredAudioLatencyMs: number | null;
  setReactionOffsetMs: (ms: number) => void;
  setMeasuredAudioLatencyMs: (ms: number) => void;
};

const SettingsContext = createContext<SettingsValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [reactionOffsetMs, setOffset] = useState(DEFAULT_REACTION_OFFSET_MS);
  const [measuredAudioLatencyMs, setMeasured] = useState<number | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setOffset(await getReactionOffsetMs());
        setMeasured(await getMeasuredAudioLatencyMs());
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

  return (
    <SettingsContext.Provider
      value={{
        ready,
        reactionOffsetMs,
        measuredAudioLatencyMs,
        setReactionOffsetMs,
        setMeasuredAudioLatencyMs,
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
