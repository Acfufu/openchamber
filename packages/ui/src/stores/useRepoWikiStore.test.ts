import { beforeEach, describe, expect, mock, test } from 'bun:test';

interface StatusPayload {
  wiki: {
    commit: string | null;
    language: string;
    diagrams: boolean;
    model: { providerID: string; modelID: string } | null;
    generatedAt: string | null;
    run: {
      status: 'running' | 'done' | 'stopped' | 'failed';
      stage: string | null;
      startedAt: string | null;
      finishedAt: string | null;
      error: string | null;
      errorCode: string | null;
      generatedPages: number | null;
      failedPages: number | null;
      retriedPage: string | null;
    } | null;
    catalog: { pages: unknown[] } | null;
  } | null;
  stale: boolean;
  runActive: boolean;
}

const statusPayload = (overrides: Partial<StatusPayload> = {}): StatusPayload => ({
  wiki: {
    commit: 'abc123',
    language: 'en',
    diagrams: true,
    model: { providerID: 'p', modelID: 'm' },
    generatedAt: '2026-01-01T00:00:00Z',
    run: { status: 'done', stage: 'done', startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:01:00Z', error: null, errorCode: null, generatedPages: 1, failedPages: null, retriedPage: null },
    catalog: { pages: [] },
  },
  stale: false,
  runActive: false,
  ...overrides,
});

const handlers = {
  fetchStatus: async (): Promise<StatusPayload> => statusPayload(),
  fetchPage: async (): Promise<string> => '# Page',
  generate: async (): Promise<{ started: boolean }> => ({ started: true }),
  stop: async (): Promise<{ stopped: boolean }> => ({ stopped: true }),
  retry: async (): Promise<{ retried: boolean }> => ({ retried: true }),
  remove: async (): Promise<{ deleted: boolean }> => ({ deleted: true }),
};

const calls = { fetchStatus: 0, fetchPage: 0, generate: 0, stop: 0, retry: 0, remove: 0 };

/** Mirrors the api-layer error class; the mock swaps the module wholesale. */
class RepoWikiRequestError extends Error {
  readonly code: string | null;
  readonly requiredChars: number | null;
  readonly availableChars: number | null;

  constructor(message: string, code: string | null, requiredChars: number | null, availableChars: number | null) {
    super(message);
    this.name = 'RepoWikiRequestError';
    this.code = code;
    this.requiredChars = requiredChars;
    this.availableChars = availableChars;
  }
}

// Follows the local store-test precedent: swap plain handlers instead of using
// mock helpers, because the UI tsconfig does not load bun's test globals.
mock.module('@/lib/repoWikiApi', () => ({
  resolveRepoWikiProjectId: (projectPath: string) => `path_${projectPath}`,
  fetchRepoWikiStatus: () => {
    calls.fetchStatus += 1;
    return handlers.fetchStatus();
  },
  fetchRepoWikiPage: () => {
    calls.fetchPage += 1;
    return handlers.fetchPage();
  },
  startRepoWikiGeneration: () => {
    calls.generate += 1;
    return handlers.generate();
  },
  stopRepoWikiGeneration: () => {
    calls.stop += 1;
    return handlers.stop();
  },
  retryRepoWikiPage: () => {
    calls.retry += 1;
    return handlers.retry();
  },
  deleteRepoWiki: () => {
    calls.remove += 1;
    return handlers.remove();
  },
  RepoWikiRequestError,
}));

const { useRepoWikiStore } = await import('./useRepoWikiStore');

const PROJECT_PATH = '/repo';
const store = () => useRepoWikiStore.getState();
const entry = () => store().getEntry(PROJECT_PATH);

const failWith = (message: string) => async (): Promise<never> => {
  throw new Error(message);
};

beforeEach(() => {
  store().reset();
  calls.fetchStatus = 0;
  calls.fetchPage = 0;
  calls.generate = 0;
  calls.stop = 0;
  calls.retry = 0;
  calls.remove = 0;
  handlers.fetchStatus = async () => statusPayload();
  handlers.fetchPage = async () => '# Page';
  handlers.generate = async () => ({ started: true });
  handlers.stop = async () => ({ stopped: true });
  handlers.retry = async () => ({ retried: true });
  handlers.remove = async () => ({ deleted: true });
});

describe('useRepoWikiStore', () => {
  test('load caches status and marks the entry loaded', async () => {
    await store().load(PROJECT_PATH);
    expect(calls.fetchStatus).toBe(1);
    expect(entry().loaded).toBe(true);
    expect(entry().status?.wiki?.commit).toBe('abc123');
    expect(entry().error).toBeNull();
  });

  test('load skips a loaded entry unless forced', async () => {
    await store().load(PROJECT_PATH);
    await store().load(PROJECT_PATH);
    expect(calls.fetchStatus).toBe(1);
    await store().load(PROJECT_PATH, { force: true });
    expect(calls.fetchStatus).toBe(2);
  });

  test('a failed load records the error and preserves the previous snapshot', async () => {
    await store().load(PROJECT_PATH);
    const first = entry().status;
    handlers.fetchStatus = failWith('server exploded');

    await store().load(PROJECT_PATH, { force: true });

    expect(entry().error).toBe('server exploded');
    expect(entry().errorCode).toBe('read-status');
    expect(entry().status).toBe(first);
  });

  test('a coded failure keeps its code and clears with the next success', async () => {
    handlers.fetchStatus = async () => {
      throw new RepoWikiRequestError('Malformed Repo Wiki status response', 'malformed-response', null, null);
    };
    await store().load(PROJECT_PATH, { force: true });
    expect(entry().error).toBe('Malformed Repo Wiki status response');
    expect(entry().errorCode).toBe('malformed-response');

    handlers.fetchStatus = async () => statusPayload();
    await store().load(PROJECT_PATH, { force: true });
    expect(entry().error).toBeNull();
    expect(entry().errorCode).toBeNull();
  });

  test('a context-too-small refusal carries its budget numbers for localization', async () => {
    handlers.generate = async () => {
      throw new RepoWikiRequestError('Input is too large', 'context-too-small', 90_000, 60_000);
    };
    expect(await store().generate(PROJECT_PATH)).toBe(false);
    expect(entry().errorCode).toBe('context-too-small');
    expect(entry().errorDetail).toEqual({ requiredChars: 90_000, availableChars: 60_000 });
  });

  test('loadPage caches markdown and reports failure as null', async () => {
    const first = await store().loadPage(PROJECT_PATH, 'overview');
    expect(first).toBe('# Page');
    const second = await store().loadPage(PROJECT_PATH, 'overview');
    expect(second).toBe('# Page');
    expect(calls.fetchPage).toBe(1);

    handlers.fetchPage = failWith('page gone');
    expect(await store().loadPage(PROJECT_PATH, 'other')).toBeNull();
    expect(entry().error).toBe('page gone');
  });

  test('generate refreshes status and reports failure as false', async () => {
    expect(await store().generate(PROJECT_PATH, { language: 'en' })).toBe(true);
    expect(calls.generate).toBe(1);
    expect(entry().status?.wiki?.commit).toBe('abc123');

    handlers.generate = failWith('no model');
    expect(await store().generate(PROJECT_PATH)).toBe(false);
    expect(entry().error).toBe('no model');
  });

  test('stop and retryPage report failure as false and record the error', async () => {
    expect(await store().stop(PROJECT_PATH)).toBe(true);
    expect(await store().retryPage(PROJECT_PATH, 'overview')).toBe(true);

    handlers.stop = failWith('stop failed');
    handlers.retry = failWith('retry failed');
    expect(await store().stop(PROJECT_PATH)).toBe(false);
    expect(await store().retryPage(PROJECT_PATH, 'overview')).toBe(false);
    expect(entry().error).toBe('retry failed');
  });

  test('remove clears the entry; a failed remove keeps it with an error', async () => {
    await store().load(PROJECT_PATH);
    expect(await store().remove(PROJECT_PATH)).toBe(true);
    expect(store().getEntry(PROJECT_PATH).loaded).toBe(false);

    handlers.remove = failWith('delete failed');
    expect(await store().remove(PROJECT_PATH)).toBe(false);
  });

  test('visible panel with an active run polls until the run ends', async () => {
    // bun:test has no fake timers; collect the poller's timeout callback and
    // fire it by hand, exactly as the elapsed interval would.
    const base = statusPayload();
    const running: StatusPayload = {
      ...base,
      runActive: true,
      wiki: base.wiki === null ? null : {
        ...base.wiki,
        run: { status: 'running', stage: 'pages', startedAt: 'x', finishedAt: null, error: null, errorCode: null, generatedPages: 0, failedPages: null, retriedPage: null },
      },
    };
    let active = running;
    handlers.fetchStatus = async () => active;

    let pollTicks: Array<() => void> = [];
    const originalSetTimeout = globalThis.setTimeout;
    // SAFETY: the only timer scheduled in this test is the store's poll tick,
    // so every handler here is the zero-argument callback we fire by hand.
    (globalThis as { setTimeout: unknown }).setTimeout = (handler: () => void) => {
      pollTicks = [...pollTicks, handler];
      return 1;
    };

    try {
      await store().load(PROJECT_PATH);
      store().setPanelVisible(PROJECT_PATH, true);
      expect(pollTicks.length).toBe(1);

      const ticks = pollTicks;
      pollTicks = [];
      for (const tick of ticks) tick?.();
      for (let turn = 0; turn < 25; turn += 1) await Promise.resolve();
      expect(calls.fetchStatus).toBe(2);
      // Still active: the next tick was scheduled again.
      expect(pollTicks.length).toBe(1);

      // The run ends; the poller stops instead of polling forever.
      active = statusPayload({ runActive: false });
      const secondTicks = pollTicks;
      pollTicks = [];
      for (const tick of secondTicks) tick?.();
      for (let turn = 0; turn < 25; turn += 1) await Promise.resolve();
      expect(calls.fetchStatus).toBe(3);
      expect(pollTicks.length).toBe(0);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      store().setPanelVisible(PROJECT_PATH, false);
    }
  });

  test('an invisible panel never polls', async () => {
    handlers.fetchStatus = async () => statusPayload({ runActive: true });

    let timerScheduled = false;
    const originalSetTimeout = globalThis.setTimeout;
    // SAFETY: this test only observes whether any timer gets scheduled.
    (globalThis as { setTimeout: unknown }).setTimeout = () => {
      timerScheduled = true;
      return 1;
    };

    try {
      await store().load(PROJECT_PATH);
      store().setPanelVisible(PROJECT_PATH, false);
      expect(timerScheduled).toBe(false);
      expect(calls.fetchStatus).toBe(1);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test('a turn-complete revalidate silently refetches a visible idle project', async () => {
    await store().load(PROJECT_PATH);
    store().setPanelVisible(PROJECT_PATH, true);
    expect(calls.fetchStatus).toBe(1);

    store().revalidateOnTurnComplete(PROJECT_PATH);
    for (let turn = 0; turn < 25; turn += 1) await Promise.resolve();
    expect(calls.fetchStatus).toBe(2);
    // Silent: the cached snapshot never flips to a loading state.
    expect(entry().loading).toBe(false);

    // An invisible panel has nothing to revalidate for.
    store().setPanelVisible(PROJECT_PATH, false);
    store().revalidateOnTurnComplete(PROJECT_PATH);
    for (let turn = 0; turn < 25; turn += 1) await Promise.resolve();
    expect(calls.fetchStatus).toBe(2);
  });

  test('the turn-complete revalidate skips a project with an active run', async () => {
    handlers.fetchStatus = async () => statusPayload({ runActive: true });

    let timerScheduled = false;
    const originalSetTimeout = globalThis.setTimeout;
    // SAFETY: only observing whether the poller, not the revalidate, reacts.
    (globalThis as { setTimeout: unknown }).setTimeout = () => {
      timerScheduled = true;
      return 1;
    };

    try {
      await store().load(PROJECT_PATH);
      store().setPanelVisible(PROJECT_PATH, true);
      expect(calls.fetchStatus).toBe(1);

      store().revalidateOnTurnComplete(PROJECT_PATH);
      for (let turn = 0; turn < 25; turn += 1) await Promise.resolve();
      expect(calls.fetchStatus).toBe(1);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      store().setPanelVisible(PROJECT_PATH, false);
    }
  });

  test('the turn-complete revalidate only touches the matching project', async () => {
    await store().load(PROJECT_PATH);
    await store().load('/other-repo');
    store().setPanelVisible(PROJECT_PATH, true);
    store().setPanelVisible('/other-repo', true);
    expect(calls.fetchStatus).toBe(2);

    store().revalidateOnTurnComplete('/other-repo');
    for (let turn = 0; turn < 25; turn += 1) await Promise.resolve();
    expect(calls.fetchStatus).toBe(3);

    store().revalidateOnTurnComplete(PROJECT_PATH);
    for (let turn = 0; turn < 25; turn += 1) await Promise.resolve();
    expect(calls.fetchStatus).toBe(4);
  });
});
