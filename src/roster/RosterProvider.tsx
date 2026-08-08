// Roster + practice-queue state for the whole app. Follows the existing provider
// pattern (SettingsProvider / V2Provider): a context at the root, SQLite-backed,
// no new state library.
//
// All queue RULES live in ./queue (pure, verified by scripts/verify-queue.mjs).
// This file only holds the loaded data, persists changes, and exposes actions —
// so the semantics stay testable without React.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import {
  getQueueState,
  listAthletes,
  setQueueState,
  type Athlete,
} from '../db/database';
import {
  EMPTY_QUEUE,
  advance as advanceQueue,
  currentAthleteId,
  jumpTo as jumpToAthlete,
  loadTemplate as loadTemplateIds,
  reorder as reorderQueue,
  removeFromQueue,
  addToQueue,
  upNext as upNextIds,
  type QueueState,
} from './queue';

/** How long the "restarting lineup" banner stays up after a wrap. The wrap must
 *  be VISIBLE — silently snapping back to the first athlete looks like a bug. */
export const WRAP_NOTICE_MS = 6000;

/** How long "Skipped X · Undo" stays offered. */
export const SKIP_UNDO_MS = 10000;

export type SkipUndo = {
  /** who was skipped, for the affordance's label */
  name: string;
  /** the ENTIRE queue state before the skip — undo restores this verbatim
   *  rather than trying to invert the move, so it is exact by construction */
  prev: QueueState;
  /** the skip caused a wrap; undo must also retract that announcement */
  wrapped: boolean;
};

/** The cursor move made by the last completed run, while it is still revertible.
 *  Discarding that run must put its athlete back up — the rep didn't count, so
 *  the queue shouldn't have moved on. Same snapshot mechanism as SkipUndo. */
export type AdvanceUndo = { prev: QueueState; wrapped: boolean };

type RosterContextValue = {
  ready: boolean;
  /** every athlete, archived included (lists filter as they need) */
  athletes: Athlete[];
  /** active (non-archived) athletes, the pickable roster */
  activeAthletes: Athlete[];
  byId: (id: string | null | undefined) => Athlete | null;
  queue: QueueState;
  /** who the next run is attributed to (override, else cursor); null = Unassigned */
  currentAthlete: Athlete | null;
  /** the next two (or `count`) after the cursor, for the strip */
  upNext: (count?: number) => Athlete[];
  /** the lineup just wrapped — show "restarting lineup" until it clears */
  justWrapped: boolean;
  /** call after a run is COMMITTED (kept). Advances the cursor; discarding a run
   *  must not call this, which is why it isn't wired into saveRun itself. */
  completeRun: () => void;
  /** Move past whoever is up WITHOUT recording a run — they stay in the lineup
   *  and come round again on the wrap. Distinct from removal, which is the
   *  lineup toggle in Roster. */
  skipCurrent: () => void;
  /** The most recent skip, while it is still undoable; null otherwise. */
  lastSkip: SkipUndo | null;
  /** Restore the queue to exactly its pre-skip state. */
  undoSkip: () => void;
  /** Undo the cursor move made by the last completeRun(), if it is still the most
   *  recent queue change. Returns false if anything happened since, in which case
   *  the snapshot is stale and restoring it would clobber that change.
   *  Called when a run is DISCARDED: the rep didn't count, so its athlete is up
   *  again rather than having silently lost their turn. */
  revertAdvance: () => boolean;
  jumpTo: (athleteId: string) => void;
  setQueue: (ids: string[]) => void;
  addAthleteToQueue: (athleteId: string) => void;
  removeAthleteFromQueue: (athleteId: string) => void;
  moveInQueue: (from: number, to: number) => void;
  loadTemplate: (athleteIds: string[]) => void;
  clearQueue: () => void;
  /** re-read athletes (after roster edits elsewhere) */
  refresh: () => Promise<void>;
};

const RosterContext = createContext<RosterContextValue | null>(null);

export function RosterProvider({ children }: { children: ReactNode }) {
  const [athletes, setAthletes] = useState<Athlete[]>([]);
  const [queue, setQueueLocal] = useState<QueueState>(EMPTY_QUEUE);
  const [ready, setReady] = useState(false);
  const [justWrapped, setJustWrapped] = useState(false);
  const [lastSkip, setLastSkip] = useState<SkipUndo | null>(null);
  const [lastAdvance, setLastAdvance] = useState<AdvanceUndo | null>(null);
  const wrapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      setAthletes(await listAthletes({ includeArchived: true }));
    } catch {
      /* keep what we have */
    }
  }, []);

  // Hydrate once: roster + the persisted lineup (both survive app restarts).
  useEffect(() => {
    (async () => {
      try {
        const [list, q] = await Promise.all([listAthletes({ includeArchived: true }), getQueueState()]);
        setAthletes(list);
        setQueueLocal(q);
      } catch {
        /* defaults */
      } finally {
        setReady(true);
      }
    })();
  }, []);

  useEffect(() => () => {
    if (wrapTimer.current) clearTimeout(wrapTimer.current);
    if (skipTimer.current) clearTimeout(skipTimer.current);
  }, []);

  // Every mutation goes through here so persistence can't be forgotten.
  const commit = useCallback((next: QueueState) => {
    setQueueLocal(next);
    setQueueState(next).catch(() => {});
  }, []);

  const activeAthletes = useMemo(() => athletes.filter((a) => a.archived_at == null), [athletes]);
  const activeIds = useMemo(() => new Set(activeAthletes.map((a) => a.id)), [activeAthletes]);
  const index = useMemo(() => new Map(athletes.map((a) => [a.id, a])), [athletes]);

  const byId = useCallback(
    (id: string | null | undefined) => (id ? (index.get(id) ?? null) : null),
    [index],
  );

  const currentAthlete = useMemo(
    () => byId(currentAthleteId(queue, activeIds)),
    [queue, activeIds, byId],
  );

  const upNext = useCallback(
    (count = 2) =>
      upNextIds(queue, activeIds, count)
        .map((id) => index.get(id))
        .filter((a): a is Athlete => a != null),
    [queue, activeIds, index],
  );

  // BOTH snapshots (skip and advance) go stale the moment anything else changes
  // the queue — restoring one would silently clobber whatever happened since. So
  // every mutation drops both rather than risking it, and they are cleared
  // together so a new one can never be reachable through a path that forgot.
  //
  // Note the asymmetry in TIMERS, not in invalidation: the skip undo expires on a
  // clock (SKIP_UNDO_MS) because it is a transient toast, while the advance undo
  // has no timer — it backs the discard window, which stays open until the next
  // rep. A cursor that quietly stopped being revertible halfway through that
  // window would be worse than one that never was.
  const clearUndos = useCallback(() => {
    setLastSkip(null);
    setLastAdvance(null);
    if (skipTimer.current) clearTimeout(skipTimer.current);
  }, []);

  // The single place the cursor moves. completeRun and skipCurrent are separate
  // PUBLIC verbs that happen to share it today — keeping them distinct is what
  // lets the discard window later delay completeRun (to the point the window
  // closes) without skip inheriting that delay, and without either advancing twice.
  const advanceCursor = useCallback((): { prev: QueueState; wrapped: boolean } => {
    const prev = queue;
    const { next, wrapped } = advanceQueue(queue, activeIds);
    commit(next);
    if (wrapped) {
      setJustWrapped(true);
      if (wrapTimer.current) clearTimeout(wrapTimer.current);
      wrapTimer.current = setTimeout(() => setJustWrapped(false), WRAP_NOTICE_MS);
    }
    return { prev, wrapped };
  }, [queue, activeIds, commit]);

  const completeRun = useCallback(() => {
    clearUndos(); // a recorded run supersedes an undoable skip
    setLastAdvance(advanceCursor());
  }, [advanceCursor, clearUndos]);

  // Mirrors undoSkip. Returns false when the snapshot is stale — the caller (the
  // discard control) still deletes the run; it just leaves the cursor alone rather
  // than undoing whatever the coach did in the meantime.
  const revertAdvance = useCallback((): boolean => {
    if (!lastAdvance) return false;
    commit(lastAdvance.prev);
    if (lastAdvance.wrapped) {
      setJustWrapped(false);
      if (wrapTimer.current) clearTimeout(wrapTimer.current);
    }
    setLastAdvance(null);
    return true;
  }, [lastAdvance, commit]);

  // No run is written, so this is fully reversible. (A pending one-off jump is
  // consumed instead of the cursor moving, which is right: you're skipping
  // whoever is up — and that is captured by the snapshot too.)
  const skipCurrent = useCallback(() => {
    const who = currentAthlete;
    if (!who) return;
    clearUndos(); // a skip supersedes a revertible run-advance, and vice versa
    const { prev, wrapped } = advanceCursor();
    setLastSkip({ name: who.display_name, prev, wrapped });
    if (skipTimer.current) clearTimeout(skipTimer.current);
    skipTimer.current = setTimeout(() => setLastSkip(null), SKIP_UNDO_MS);
  }, [advanceCursor, currentAthlete, clearUndos]);

  // Restores the WHOLE pre-skip state, so the cursor (and any consumed override)
  // comes back exactly — including after a wrap, where the announcement is
  // retracted too because the lineup did not actually restart.
  const undoSkip = useCallback(() => {
    if (!lastSkip) return;
    commit(lastSkip.prev);
    if (lastSkip.wrapped) {
      setJustWrapped(false);
      if (wrapTimer.current) clearTimeout(wrapTimer.current);
    }
    clearUndos();
  }, [lastSkip, commit, clearUndos]);

  const jumpTo = useCallback(
    (athleteId: string) => {
      // A deliberate jump means the coach has taken control of who's up, so any
      // stale "restarting lineup" notice is no longer what they're looking at.
      setJustWrapped(false);
      clearUndos();
      commit(jumpToAthlete(queue, athleteId));
    },
    [queue, commit, clearUndos],
  );

  const setQueue = useCallback(
    (ids: string[]) => {
      // Keep the cursor on the same PERSON when possible; otherwise start at the
      // top of the new lineup.
      const cursorId = queue.cursorId && ids.includes(queue.cursorId) ? queue.cursorId : (ids[0] ?? null);
      clearUndos();
      commit({ athleteIds: ids, cursorId, overrideId: queue.overrideId });
    },
    [queue, commit, clearUndos],
  );

  const addAthleteToQueue = useCallback(
    (athleteId: string) => {
      clearUndos();
      commit(addToQueue(queue, athleteId));
    },
    [queue, commit, clearUndos],
  );
  const removeAthleteFromQueue = useCallback(
    (athleteId: string) => {
      clearUndos();
      commit(removeFromQueue(queue, athleteId));
    },
    [queue, commit, clearUndos],
  );
  const moveInQueue = useCallback(
    (from: number, to: number) => {
      clearUndos(); // the snapshot holds the OLD order — restoring it would undo the reorder
      commit(reorderQueue(queue, from, to));
    },
    [queue, commit, clearUndos],
  );
  const loadTemplate = useCallback(
    (athleteIds: string[]) => {
      setJustWrapped(false);
      clearUndos();
      commit(loadTemplateIds(athleteIds));
    },
    [commit, clearUndos],
  );
  const clearQueue = useCallback(() => {
    setJustWrapped(false);
    clearUndos();
    commit(EMPTY_QUEUE);
  }, [commit, clearUndos]);

  const value: RosterContextValue = {
    ready,
    athletes,
    activeAthletes,
    byId,
    queue,
    currentAthlete,
    upNext,
    justWrapped,
    completeRun,
    skipCurrent,
    lastSkip,
    undoSkip,
    revertAdvance,
    jumpTo,
    setQueue,
    addAthleteToQueue,
    removeAthleteFromQueue,
    moveInQueue,
    loadTemplate,
    clearQueue,
    refresh,
  };

  return <RosterContext.Provider value={value}>{children}</RosterContext.Provider>;
}

export function useRoster(): RosterContextValue {
  const ctx = useContext(RosterContext);
  if (!ctx) throw new Error('useRoster must be used within a RosterProvider');
  return ctx;
}
