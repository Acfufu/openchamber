import React from 'react';
import { create } from 'zustand';

import { useUIStore } from '@/stores/useUIStore';
import { fetchWorkflowRuns } from './api';
import type { WorkflowRun } from './model';

/**
 * Workflow runs per session, as the chat card and the work-status panel show
 * them. A session's list is read once from the server; after that the
 * server's `openchamber:workflow-run` events keep each run current.
 *
 * A failed read never blanks runs already held: it leaves them and records the
 * error, so the card of a running workflow does not vanish over a hiccup.
 */

type SessionRuns = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  runs: WorkflowRun[];
};

interface WorkflowRunsState {
  bySession: Record<string, SessionRuns>;
  load: (sessionId: string) => Promise<void>;
  apply: (run: WorkflowRun) => void;
  /** Reads again every session a surface has asked about, after a gap in events. */
  reloadLoaded: () => void;
  reset: () => void;
}

const EMPTY_RUNS: WorkflowRun[] = [];

const upsert = (runs: WorkflowRun[], run: WorkflowRun): WorkflowRun[] => {
  const index = runs.findIndex((candidate) => candidate.id === run.id);
  if (index === -1) return [...runs, run].sort((left, right) => left.createdAt - right.createdAt);
  const next = runs.slice();
  next[index] = run;
  return next;
};

/**
 * A store over `fetchRuns`; the app's one reads the OpenChamber server, tests
 * pass their own.
 */
export const createWorkflowRunsStore = (fetchRuns: (sessionId: string) => Promise<WorkflowRun[]>) => {
  // Event order: a run an event touched after a read started is newer than
  // what that read returns, so the read keeps it.
  let eventSequence = 0;
  const touchedAt = new Map<string, number>();
  // Each session's newest read. The counter never restarts, so a read that
  // was on its way when the runtime changed can never pass for a newer one.
  let requestSequence = 0;
  const loadSequence = new Map<string, number>();

  return create<WorkflowRunsState>((set, get) => ({
    bySession: {},

    load: async (sessionId) => {
      const startedAt = eventSequence;
      requestSequence += 1;
      const request = requestSequence;
      loadSequence.set(sessionId, request);
      const before = get().bySession[sessionId];
      set((state) => ({ bySession: { ...state.bySession, [sessionId]: { status: 'loading', runs: before?.runs ?? EMPTY_RUNS } } }));
      try {
        const fetched = await fetchRuns(sessionId);
        if (loadSequence.get(sessionId) !== request) return;
        const held = get().bySession[sessionId]?.runs ?? EMPTY_RUNS;
        let runs = fetched;
        for (const run of held) {
          if ((touchedAt.get(run.id) ?? -1) > startedAt) runs = upsert(runs, run);
        }
        set((state) => ({ bySession: { ...state.bySession, [sessionId]: { status: 'ready', runs } } }));
      } catch {
        if (loadSequence.get(sessionId) !== request) return;
        set((state) => ({ bySession: { ...state.bySession, [sessionId]: { status: 'error', runs: state.bySession[sessionId]?.runs ?? EMPTY_RUNS } } }));
      }
    },

    apply: (run) => {
      eventSequence += 1;
      touchedAt.set(run.id, eventSequence);
      set((state) => {
        const current = state.bySession[run.parentSessionId];
        return {
          bySession: {
            ...state.bySession,
            [run.parentSessionId]: { status: current?.status ?? 'idle', runs: upsert(current?.runs ?? EMPTY_RUNS, run) },
          },
        };
      });
    },

    reloadLoaded: () => {
      for (const [sessionId, entry] of Object.entries(get().bySession)) {
        if (entry.status !== 'idle') void get().load(sessionId);
      }
    },

    reset: () => {
      touchedAt.clear();
      loadSequence.clear();
      set({ bySession: {} });
    },
  }));
};

export const useWorkflowRunsStore = createWorkflowRunsStore(fetchWorkflowRuns);

/**
 * The workflow runs of a session, read from the server the first time a
 * surface asks. Empty in builds without workflows.
 */
export const useSessionWorkflowRuns = (sessionId: string | null): WorkflowRun[] => {
  const available = useUIStore((state) => state.agentWorkflowFeatureAvailable);
  const runs = useWorkflowRunsStore((state) => (sessionId ? state.bySession[sessionId]?.runs : undefined) ?? EMPTY_RUNS);
  const load = useWorkflowRunsStore((state) => state.load);

  // Read when a surface first shows the session, and again on the next mount
  // after a failed read; while a read runs or after one landed, events and
  // reconnects keep the list current.
  React.useEffect(() => {
    if (!available || !sessionId) return;
    const current = useWorkflowRunsStore.getState().bySession[sessionId]?.status;
    if (current === 'ready' || current === 'loading') return;
    void load(sessionId);
  }, [available, load, sessionId]);

  return available ? runs : EMPTY_RUNS;
};

/** One run of a session by id, for the chat card of the call that proposed it. */
export const useWorkflowRun = (sessionId: string | null, runId: string | null): WorkflowRun | null => {
  const runs = useSessionWorkflowRuns(sessionId);
  return React.useMemo(() => (runId ? runs.find((run) => run.id === runId) ?? null : null), [runId, runs]);
};
