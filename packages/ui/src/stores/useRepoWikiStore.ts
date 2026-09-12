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
  RepoWikiRequestError,
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

export interface RepoWikiEntryErrorDetail {
  requiredChars: number | null;
  availableChars: number | null;
}

export interface RepoWikiEntry {
  status: RepoWikiStatusResult | null;
  pages: Record<string, RepoWikiPageContent>;
  /** True once an authoritative load has succeeded at least once. */
  loaded: boolean;
  loading: boolean;
  /** Last load or command failure. Never clears cached data on its own. */
  error: string | null;
  /** Stable failure code — server code or command fallback — for localization. */
  errorCode: string | null;
  /** Input budget numbers for a `context-too-small` failure, when known. */
  errorDetail: RepoWikiEntryErrorDetail | null;
}

interface RepoWikiState {
  entries: Record<string, RepoWikiEntry>;
}

interface RepoWikiActions {
  getEntry: (projectPath: string | null | undefined) => RepoWikiEntry;
  load: (projectPath: string, options?: { force?: boolean; silent?: boolean }) => Promise<void>;
  loadPage: (projectPath: string, pageId: string, options?: { force?: boolean }) => Promise<string | null>;
  generate: (projectPath: string, options?: RepoWikiGenerateOptions) => Promise<boolean>;
  stop: (projectPath: string) => Promise<boolean>;
  retryPage: (projectPath: string, pageId: string, options?: { retries?: number }) => Promise<boolean>;
  remove: (projectPath: string) => Promise<boolean>;
  /** The panel reports visibility; this starts or stops the run poller. */
  setPanelVisible: (projectPath: string | null, visible: boolean) => void;
  /**
   * Conversation-turn signal: a visible, mounted panel whose project has no
   * active run silently revalidates its status. Freshness while a run is
   * active belongs to the poller; an invisible panel revalidates on mount.
   */
  revalidateOnTurnComplete: (projectPath: string) => void;
  reset: () => void;
}

type RepoWikiStore = RepoWikiState & RepoWikiActions;

export const EMPTY_REPO_WIKI_ENTRY: RepoWikiEntry = {
  status: null,
  pages: {},
  loaded: false,
  loading: false,
  error: null,
  errorCode: null,
  errorDetail: null,
};

const POLL_INTERVAL_MS = 1_500;

/**
 * Per-project command chains: generate/stop/retry/delete serialize so two
 * commands cannot interleave. Coordination state, not rendered state — kept
 * outside the store on purpose.
 */
const commandChains = new Map<string, Promise<unknown>>();

/** Success paths clear all three failure fields together. */
const CLEAR_ERROR = { error: null, errorCode: null, errorDetail: null };

/**
 * One failure record from any load or command: the raw message stays the
 * ultimate fallback, the stable code (the server's, or this command's when
 * the failure had none) lets the panel localize, and a context-too-small
 * refusal rides along with its budget numbers.
 */
const errorFieldsOf = (error: Error | undefined, fallbackCode: string): Pick<RepoWikiEntry, 'error' | 'errorCode' | 'errorDetail'> => {
  const message = error?.message || '';
  if (!(error instanceof RepoWikiRequestError)) {
    return { error: message, errorCode: fallbackCode, errorDetail: null };
  }
  const code = error.code ?? fallbackCode;
  const errorDetail = code === 'context-too-small'
    ? { requiredChars: error.requiredChars, availableChars: error.availableChars }
    : null;
  return { error: message, errorCode: code, errorDetail };
};

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

  const refresh = async ({ projectPath, projectId, fromPoller = false, silent = false }: {
    projectPath: string;
    projectId: string;
    fromPoller?: boolean;
    /** A silent refresh keeps the cached snapshot visible and skips the loading flag. */
    silent?: boolean;
  }) => {
    if (!fromPoller && !silent) {
      patchEntry(projectId, { loading: true });
    }
    const previousRunStatus = entryFor(projectId).status?.wiki?.run?.status;
    try {
      const status = await fetchRepoWikiStatus(projectPath);
      patchEntry(projectId, { status, loaded: true, loading: false, ...CLEAR_ERROR });
      // A run just ended: cached page markdown may be superseded (retry,
      // regeneration), so the cache gives way to the fresh files.
      if (previousRunStatus === 'running' && status.wiki?.run?.status !== 'running') {
        patchEntry(projectId, { pages: {} });
      }
      if (isRunActive(projectId) && visiblePanels.has(projectId)) {
        scheduleTick(projectId, projectPath);
      } else {
        stopPoller(projectId);
      }
    } catch (error) {
      patchEntry(projectId, { loading: false, ...errorFieldsOf(error instanceof Error ? error : undefined, 'read-status') });
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
      // A cached entry revalidates silently on mount, so a wiki created
      // elsewhere (another window, a new run) shows up without a flash.
      await refresh({ projectPath, projectId, silent: options.silent === true && entry.loaded });
    },

    loadPage: async (projectPath, pageId, options = {}) => {
      const projectId = resolveRepoWikiProjectId(projectPath);
      const cached = entryFor(projectId).pages[pageId];
      if (cached && !options.force) return cached.markdown;
      try {
        const markdown = await fetchRepoWikiPage(projectPath, pageId);
        patchEntry(projectId, {
          pages: { ...entryFor(projectId).pages, [pageId]: { markdown } },
        });
        return markdown;
      } catch (error) {
        patchEntry(projectId, errorFieldsOf(error instanceof Error ? error : undefined, 'read-page'));
        return null;
      }
    },

    generate: async (projectPath, options = {}) => {
      const projectId = resolveRepoWikiProjectId(projectPath);
      return enqueueCommand(projectId, async () => {
        try {
          await startRepoWikiGeneration(projectPath, options);
          patchEntry(projectId, { ...CLEAR_ERROR });
          await refresh({ projectPath, projectId });
        } catch (error) {
          patchEntry(projectId, errorFieldsOf(error instanceof Error ? error : undefined, 'start-generation'));
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
          patchEntry(projectId, errorFieldsOf(error instanceof Error ? error : undefined, 'stop-generation'));
          throw error;
        }
      }).then(() => true).catch(() => false);
    },

    retryPage: async (projectPath, pageId, options = {}) => {
      const projectId = resolveRepoWikiProjectId(projectPath);
      return enqueueCommand(projectId, async () => {
        try {
          await retryRepoWikiPage(projectPath, pageId, options);
          patchEntry(projectId, { ...CLEAR_ERROR });
          await refresh({ projectPath, projectId });
        } catch (error) {
          patchEntry(projectId, errorFieldsOf(error instanceof Error ? error : undefined, 'retry-page'));
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
          patchEntry(projectId, errorFieldsOf(error instanceof Error ? error : undefined, 'delete-wiki'));
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

    revalidateOnTurnComplete: (projectPath) => {
      const projectId = resolveRepoWikiProjectId(projectPath);
      if (!visiblePanels.has(projectId) || isRunActive(projectId)) return;
      void refresh({ projectPath, projectId, silent: true });
    },

    reset: () => {
      for (const projectId of [...pollers.keys()]) stopPoller(projectId);
      visiblePanels.clear();
      set({ entries: {} });
    },
  };
});
