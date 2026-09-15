// App-wide, SQLite-backed settings exposed reactively via useSettings().
//
// Gone from here, 2026-09: the reaction-offset / measured-latency / correction-
// mode / latency-sample fields and the v2-engine toggle. All five served the v1
// Timer, which the firmware stopped speaking to in July and which is deleted.
// The database keys they wrote (reaction_offset_ms, measured_audio_latency_ms,
// correction_mode, use_v2_engine) may still exist in a settings table; nothing
// reads them, and a stray row in a key/value table is not worth a migration.
// Reaction mode returns with the gate buzzer at the PCB respin, on the v2 engine,
// and will want its own calibration rather than this one.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

import { getSetting, setSetting } from '../db/database';

type SettingsValue = {
  ready: boolean;
  // Developer/Advanced mode. OFF (default) hides all diagnostic/technical UI
  // (±X accuracy, clock-sync detail, raw split values, the Debug tab); the
  // underlying data is still measured and stored — this only gates display.
  devMode: boolean;
  // Opt-in (default OFF): reconstruct + log a gate's own B1 standalone Mode-1 run
  // from the event stream while connected. OFF by default because B1/B2 emit the
  // same BUTTON_PRESS, so a Mode-2 standalone would be mis-logged — see
  // StandaloneObserver in v2.ts. Never interferes with app-armed runs.
  logStandalone: boolean;
  setDevMode: (on: boolean) => void;
  setLogStandalone: (on: boolean) => void;
};

const SettingsContext = createContext<SettingsValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [devMode, setDev] = useState(false);
  const [logStandalone, setLogSA] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        setDev((await getSetting('dev_mode')) === '1');
        setLogSA((await getSetting('log_standalone')) === '1');
      } catch {
        /* keep defaults */
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const setDevMode = useCallback((on: boolean) => {
    setDev(on);
    setSetting('dev_mode', on ? '1' : '0').catch(() => {});
  }, []);

  const setLogStandalone = useCallback((on: boolean) => {
    setLogSA(on);
    setSetting('log_standalone', on ? '1' : '0').catch(() => {});
  }, []);

  return (
    <SettingsContext.Provider
      value={{
        ready,
        devMode,
        logStandalone,
        setDevMode,
        setLogStandalone,
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
