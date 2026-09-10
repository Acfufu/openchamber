/**
 * Repo Wiki store: one cached status per project plus page markdown, with the
 * generation lifecycle as first-class state.
 *
 * The server owns generation and storage; this store is a read-through cache.
 * A failed load records `error` and preserves the previous snapshot — failure
 * never masquerades as "no wiki".
 *
 * Polling here is visible-consumer-driven, never a root poller: a timer exists
 * only while the panel is visible AND a run is active, and it is cleared the
 * moment either condition stops holding.
 */

import { create } from 'zustand';

import {
  deleteRepoWiki,
  fetchRepoWikiPage,
  fetchRepoWikiStatus,
  resolveRepoWikiProjectId,
  retryRepoWikiPage,
  startRepoWikiGeneration,
  stopRepoWikiGeneration,
  type RepoWikiGenerateOptions,
  type RepoWikiStatusResult,
} from '@/lib/repoWikiApi';

export interface RepoWikiPageContent {
  markdown: string;
}

export interface RepoWikiEntry {
  status: RepoWikiStatusResult | null;
  pages: Record<string, RepoWikiPageContent>;
  /** True once an authoritative load has succeeded at least once. */
  loaded: boolean;
  loading: boolean;
  /** Last load or command failure. Never clears cached data on its own. */
  error: string | null;
}

interface RepoWikiState {
  entries: Record<string, RepoWikiEntry>;
}

interface RepoWikiActions {
  getEntry: (projectPath: string | null | undefined) => RepoWikiEntry;
  load: (projectPath: string, options?: { force?: boolean; silent?: boolean }) => Promise<void>;
  loadPage: (projectPath: string, pageId: string) => Promise<string | null>;
  generate: (projectPath: string, options?: RepoWikiGenerateOptions) => Promise<boolean>;
  stop: (projectPath: string) => Promise<boolean>;
  retryPage: (projectPath: string, pageId: string) => Promise<boolean>;
  remove: (projectPath: string) => Promise<boolean>;
  /** The panel reports visibility; this starts or stops the run poller. */
  setPanelVisible: (projectPath: string | null, visible: boolean) => void;
  reset: () => void;
}

type RepoWikiStore = RepoWikiState & RepoWikiActions;

export const EMPTY_REPO_WIKI_ENTRY: RepoWikiEntry = {
  status: null,
  pages: {},
  loaded: false,
  loading: false,
  error: null,
};

const POLL_INTERVAL_MS = 1_500;

/**
 * Per-project command chains: generate/stop/retry/delete serialize so two
 * commands cannot interleave. Coordination state, not rendered state — kept
 * outside the store on purpose.
 */
const commandChains = new Map<string, Promise<unknown>>();

const messageOf = (error: Error | undefined, fallback: string): string => (
  error && error.message ? error.message : fallback
);

export const useRepoWikiStore = create<RepoWikiStore>((set, get) => {
  const patchEntry = (projectId: string, patch: Partial<RepoWikiEntry>) => {
    set((state) => ({
      entries: {
        ...state.entries,
        [projectId]: { ...(state.entries[projectId] ?? EMPTY_REPO_WIKI_ENTRY), ...patch },
      },
    }));
  };

  const entryFor = (projectId: string): RepoWikiEntry => get().entries[projectId] ?? EMPTY_REPO_WIKI_ENTRY;

  /** projectId → timer. A timer exists only for a visible panel with an active run. */
  const pollers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Projects whose Repo Wiki panel is currently mounted/visible. */
  const visiblePanels = new Set<string>();

  const stopPoller = (projectId: string) => {
    const timer = pollers.get(projectId);
    if (timer) {
      clearTimeout(timer);
      pollers.delete(projectId);
    }
  };

  const isRunActive = (projectId: string): boolean => {
    const entry = entryFor(projectId);
    return entry.status?.runActive === true || entry.status?.wiki?.run?.status === 'running';
  };

  const scheduleTick = (projectId: string, projectPath: string) => {
    stopPoller(projectId);
    const timer = setTimeout(() => {
      void refresh({ projectPath, projectId, fromPoller: true });
    }, POLL_INTERVAL_MS);
    pollers.set(projectId, timer);
  };

  const refresh = async ({ projectPath, projectId, fromPoller = false }: {
    projectPath: string;
    projectId: string;
    fromPoller?: boolean;
  }) => {
    if (!fromPoller) {
      patchEntry(projectId, { loading: true });
    }
    try {
      const status = await fetchRepoWikiStatus(projectPath);
      patchEntry(projectId, { status, loaded: true, loading: false, error: null });
      if (isRunActive(projectId) && visiblePanels.has(projectId)) {
        scheduleTick(projectId, projectPath);
      } else {
        stopPoller(projectId);
      }
    } catch (error) {
      patchEntry(projectId, { loading: false, error: messageOf(error instanceof Error ? error : undefined, 'Failed to read Repo Wiki status') });
      if (fromPoller) {
        // Transient failures keep the loop alive on the real failure signal
        // (the next tick); the snapshot from before the failure stands.
        scheduleTick(projectId, projectPath);
      }
    }
  };

  const enqueueCommand = (projectId: string, operation: () => Promise<void>): Promise<void> => {
    const previous = commandChains.get(projectId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    commandChains.set(projectId, next.catch(() => undefined));
    return next;
  };

  return {
    entries: {},

    getEntry: (projectPath) => {
      if (!projectPath) return EMPTY_REPO_WIKI_ENTRY;
      return entryFor(resolveRepoWikiProjectId(projectPath));
    },

    load: async (projectPath, options = {}) => {
      const projectId = resolveRepoWikiProjectId(projectPath);
      const entry = entryFor(projectId);
      if (entry.loading) return;
      if (entry.loaded && !options.force) return;
      await refresh({ projectPath, projectId });
    },

    loadPage: async (projectPath, pageId) => {
      const projectId = resolveRepoWikiProjectId(projectPath);
      const cached = entryFor(projectId).pages[pageId];
      if (cached) return cached.markdown;
      try {
        const markdown = await fetchRepoWikiPage(projectPath, pageId);
        patchEntry(projectId, {
          pages: { ...entryFor(projectId).pages, [pageId]: { markdown } },
        });
        return markdown;
      } catch (error) {
        patchEntry(projectId, { error: messageOf(error instanceof Error ? error : undefined, 'Failed to read Repo Wiki page') });
        return null;
      }
    },

    generate: async (projectPath, options = {}) => {
      const projectId = resolveRepoWikiProjectId(projectPath);
      return enqueueCommand(projectId, async () => {
        try {
          await startRepoWikiGeneration(projectPath, options);
          patchEntry(projectId, { error: null });
          await refresh({ projectPath, projectId });
        } catch (error) {
          patchEntry(projectId, { error: messageOf(error instanceof Error ? error : undefined, 'Failed to start Repo Wiki generation') });
          throw error;
        }
      }).then(() => true).catch(() => false);
    },

    stop: async (projectPath) => {
      const projectId = resolveRepoWikiProjectId(projectPath);
      return enqueueCommand(projectId, async () => {
        try {
          await stopRepoWikiGeneration(projectPath);
          await refresh({ projectPath, projectId });
        } catch (error) {
          patchEntry(projectId, { error: messageOf(error instanceof Error ? error : undefined, 'Failed to stop Repo Wiki generation') });
          throw error;
        }
      }).then(() => true).catch(() => false);
    },

    retryPage: async (projectPath, pageId) => {
      const projectId = resolveRepoWikiProjectId(projectPath);
      return enqueueCommand(projectId, async () => {
        try {
          await retryRepoWikiPage(projectPath, pageId);
          patchEntry(projectId, { error: null });
          await refresh({ projectPath, projectId });
        } catch (error) {
          patchEntry(projectId, { error: messageOf(error instanceof Error ? error : undefined, 'Failed to retry Repo Wiki page') });
          throw error;
        }
      }).then(() => true).catch(() => false);
    },

    remove: async (projectPath) => {
      const projectId = resolveRepoWikiProjectId(projectPath);
      return enqueueCommand(projectId, async () => {
        try {
          await deleteRepoWiki(projectPath);
          stopPoller(projectId);
          set((state) => {
            const entries = { ...state.entries };
            delete entries[projectId];
            return { entries };
          });
        } catch (error) {
          patchEntry(projectId, { error: messageOf(error instanceof Error ? error : undefined, 'Failed to delete Repo Wiki') });
          throw error;
        }
      }).then(() => true).catch(() => false);
    },

    setPanelVisible: (projectPath, visible) => {
      if (!projectPath) return;
      const projectId = resolveRepoWikiProjectId(projectPath);
      if (!visible) {
        visiblePanels.delete(projectId);
        stopPoller(projectId);
        return;
      }
      visiblePanels.add(projectId);
      if (isRunActive(projectId) && !pollers.has(projectId)) {
        scheduleTick(projectId, projectPath);
      }
    },

    reset: () => {
      for (const projectId of [...pollers.keys()]) stopPoller(projectId);
      visiblePanels.clear();
      set({ entries: {} });
    },
  };
});
