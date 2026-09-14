import React, { act } from 'react';
import { expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';

import { EMPTY_REPO_WIKI_ENTRY, useRepoWikiStore, type RepoWikiEntry } from '@/stores/useRepoWikiStore';
import { resolveRepoWikiProjectId, type RepoWikiPageMeta, type RepoWikiStatus } from '@/lib/repoWikiApi';

// The turn-complete listener needs <SyncProvider>'s directory runtime, which
// no other import in this file provides; the listener itself is store-level
// behavior pinned by useRepoWikiStore.test.ts. The panel only reads the
// directory's session_status map here — an empty map is the no-sessions case.
import * as syncContext from '@/sync/sync-context';
mock.module('@/sync/sync-context', () => ({
  ...syncContext,
  useDirectorySync: () => ({}),
}));

/** Action affordances that must never render under `readOnly`. */
const FORBIDDEN_CONTROLS = ['Generate', 'Regenerate', 'Stop', 'Retry', 'Delete wiki'];
/** Generation-option labels that must never render under `readOnly`. */
const FORBIDDEN_OPTION_TEXT = ['Diagrams', 'Model', 'Retries'];

const donePage = (id: string, title: string): RepoWikiPageMeta => ({
  id, title, purpose: '', files: [], diagram: null, status: 'done', updatedAt: null, error: null, errorCode: null,
});

const storedWiki = () => ({
  commit: 'a'.repeat(40),
  branch: 'main',
  language: 'English',
  diagrams: true,
  thoughtLevel: null,
  model: null,
  generatedAt: null,
  run: null,
  catalog: { pages: [donePage('p1', 'Overview'), donePage('p2', 'Conventions')] },
} satisfies RepoWikiStatus);

const failedPage = (id: string, title: string): RepoWikiPageMeta => ({
  id, title, purpose: '', files: [], diagram: null, status: 'failed', updatedAt: null, error: 'generation failed', errorCode: 'truncated',
});

const entryWith = (patch: Partial<RepoWikiEntry>): RepoWikiEntry => ({ ...EMPTY_REPO_WIKI_ENTRY, ...patch });

interface Harness {
  container: HTMLElement;
  /** Every captured POST body, in order (repo-wiki commands included). */
  postBodies: Array<{ path: string; body: Record<string, unknown> | null }>;
  render: (directory: string, readOnly: boolean) => Promise<void>;
  unmount: () => Promise<void>;
}

/**
 * Boots happy-dom with the canonical globals, stubs fetch (the small-model
 * probe answers; repo-wiki reads stay pending so the seeded store state is
 * what renders — unless a scripted `respond` answers first), and mounts the
 * panel through the REAL stores — the same zustand modules the app uses,
 * seeded with setState.
 */
const setup = async (respond?: (url: URL, init: RequestInit | undefined) => Response | null | Promise<Response | null>): Promise<Harness> => {
  const dom = new Window({ url: 'http://localhost' });
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, location: dom.location, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node,
    customElements: dom.customElements, CSSStyleSheet: dom.CSSStyleSheet,
    Event: dom.Event, CustomEvent: dom.CustomEvent, MouseEvent: dom.MouseEvent,
    MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom), requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const originalFetch = globalThis.fetch;
  const postBodies: Array<{ path: string; body: Record<string, unknown> | null }> = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    if (init?.method === 'POST' && typeof init.body === 'string') {
      postBodies.push({ path: url.pathname, body: JSON.parse(init.body) });
    }
    if (url.pathname === '/api/small-model') return Response.json({ authenticatedProviders: [] });
    const scripted = respond ? await respond(url, init) : null;
    if (scripted) return scripted;
    return new Promise<Response>(() => {});
  }, originalFetch);

  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { RepoWikiPanel } = await import('./RepoWikiPanel');

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  return {
    container,
    postBodies,
    render: async (directory, readOnly) => {
      await act(async () => {
        root.render(<I18nProvider><RepoWikiPanel directory={directory} readOnly={readOnly} /></I18nProvider>);
      });
    },
    unmount: async () => {
      await act(async () => { root.unmount(); });
      globalThis.fetch = originalFetch;
    },
  };
};

/** Button labels plus aria-labels — delete is icon-only and only reachable by aria. */
const controlLabels = (container: HTMLElement): string[] => {
  const labels: string[] = [];
  for (const button of container.querySelectorAll('button')) {
    if (button.textContent) labels.push(button.textContent.trim());
    const aria = button.getAttribute('aria-label');
    if (aria) labels.push(aria);
  }
  return labels;
};

const seed = (directory: string, entry: RepoWikiEntry) => {
  useRepoWikiStore.setState({ entries: { [resolveRepoWikiProjectId(directory)]: entry } });
};

test('readOnly renders stored pages but no generation, retry, stop, or delete affordances', async () => {
  useRepoWikiStore.getState().reset();
  seed('/repo', entryWith({ status: { wiki: storedWiki(), stale: false, runActive: false }, loaded: true }));
  const harness = await setup();
  try {
    await harness.render('/repo', true);
    const text = harness.container.textContent ?? '';
    expect(text).toContain('Overview');
    expect(text).toContain('Conventions');
    for (const forbidden of FORBIDDEN_CONTROLS) {
      expect(controlLabels(harness.container)).not.toContain(forbidden);
    }
    for (const optionText of FORBIDDEN_OPTION_TEXT) {
      expect(text).not.toContain(optionText);
    }
  } finally {
    await harness.unmount();
  }
});

test('readOnly empty state describes the read-only surface with no Generate affordance', async () => {
  useRepoWikiStore.getState().reset();
  seed('/repo', entryWith({}));
  const harness = await setup();
  try {
    await harness.render('/repo', true);
    const text = harness.container.textContent ?? '';
    expect(text).toContain('No Repo Wiki yet');
    expect(text).toContain('This tab is for reading.');
    expect(controlLabels(harness.container)).not.toContain('Generate');
    expect(text).not.toContain('Language');
  } finally {
    await harness.unmount();
  }
});

test('readOnly keeps the informational stale banner but suppresses the Regenerate action', async () => {
  useRepoWikiStore.getState().reset();
  seed('/repo', entryWith({ status: { wiki: storedWiki(), stale: true, runActive: false }, loaded: true }));
  const harness = await setup();
  try {
    await harness.render('/repo', true);
    expect(harness.container.textContent).toContain('The code has changed since this wiki was generated.');
    expect(controlLabels(harness.container)).not.toContain('Regenerate');
  } finally {
    await harness.unmount();
  }
});

test('readOnly renders load failure alongside the empty state instead of a clean no-wiki', async () => {
  useRepoWikiStore.getState().reset();
  seed('/repo', entryWith({ error: 'status read failed' }));
  const harness = await setup();
  try {
    await harness.render('/repo', true);
    const text = harness.container.textContent ?? '';
    expect(text).toContain('status read failed');
    expect(text).toContain('This tab is for reading.');
  } finally {
    await harness.unmount();
  }
});

test('default (non-readOnly) panel keeps the generation form and options', async () => {
  useRepoWikiStore.getState().reset();
  seed('/repo', entryWith({}));
  const harness = await setup();
  try {
    await harness.render('/repo', false);
    const text = harness.container.textContent ?? '';
    expect(controlLabels(harness.container)).toContain('Generate');
    expect(text).toContain('Language');
    expect(text).toContain('Generate diagrams');
  } finally {
    await harness.unmount();
  }
});

const buttonByAria = (container: HTMLElement, aria: string): HTMLButtonElement | undefined => Array
  .from(container.querySelectorAll('button'))
  .find((button) => button.getAttribute('aria-label') === aria);

const until = async (predicate: () => boolean, timeoutMs = 8_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition not met in time');
};

const wikiWithFailedPages = () => ({
  ...storedWiki(),
  catalog: { pages: [failedPage('p1', 'First'), failedPage('p2', 'Second')] },
});

test('the failed count becomes a bulk-retry button on the active surface only', async () => {
  useRepoWikiStore.getState().reset();
  seed('/repo', entryWith({ status: { wiki: wikiWithFailedPages(), stale: false, runActive: false }, loaded: true }));
  const harness = await setup();
  try {
    await harness.render('/repo', false);
    expect(buttonByAria(harness.container, 'Retry failed pages')).toBeDefined();
    expect(harness.container.textContent).toContain('2 failed');

    await harness.render('/repo', true);
    expect(buttonByAria(harness.container, 'Retry failed pages')).toBeUndefined();
    // The count itself stays as information on the read-only tab.
    expect(harness.container.textContent).toContain('2 failed');
  } finally {
    await harness.unmount();
  }
});

test('the generate form gains the thought-level select and the default sends nothing', async () => {
  useRepoWikiStore.getState().reset();
  seed('/repo', entryWith({}));
  // Answer the command chain: a hung generate POST would hold the store's
  // per-project chain and stall any later test's commands on the same id.
  const harness = await setup(async (url, init) => {
    if (init?.method === 'POST' && url.pathname.endsWith('/generate')) {
      return Response.json({ started: true });
    }
    if (init?.method !== 'POST' && url.pathname.startsWith('/api/repo-wiki/')) {
      return Response.json({ wiki: null, runActive: false });
    }
    return null;
  });
  try {
    await harness.render('/repo', false);
    const text = harness.container.textContent ?? '';
    expect(text).toContain('Thought level');
    expect(text).toContain('Ask the model for deeper reasoning');

    const generate = Array.from(harness.container.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Generate');
    expect(generate).toBeDefined();
    await act(async () => { generate?.click(); });
    await until(() => harness.postBodies.some((entry) => entry.path.endsWith('/generate')));
    // '' (model default) maps to an absent field, exactly the pre-option wire.
    const body = harness.postBodies.find((entry) => entry.path.endsWith('/generate'))?.body;
    expect(body?.thoughtLevel).toBeUndefined();
  } finally {
    await harness.unmount();
  }
});

test('the thought-level details row is a read surface on readOnly tabs too', async () => {
  useRepoWikiStore.getState().reset();
  seed('/repo', entryWith({
    status: {
      wiki: { ...storedWiki(), thoughtLevel: 'high' },
      stale: false,
      runActive: false,
    },
    loaded: true,
  }));
  const harness = await setup();
  try {
    await harness.render('/repo', true);
    const toggle = buttonByAria(harness.container, 'Wiki details');
    expect(toggle).toBeDefined();
    await act(async () => { toggle?.click(); });
    const text = harness.container.textContent ?? '';
    expect(text).toContain('Thought level');
    expect(text).toContain('High');
    // Still a read-only surface: the generation form stays absent.
    expect(text).not.toContain('Model default');
  } finally {
    await harness.unmount();
  }
});

test('bulk retry breaks after the in-flight page when the user presses Stop', async () => {
  useRepoWikiStore.getState().reset();
  let serverRunActive = false;
  const retryPaths: string[] = [];
  const statusPayload = () => ({
    wiki: {
      ...wikiWithFailedPages(),
      run: serverRunActive
        ? {
            status: 'running' as const, stage: 'pages', startedAt: null, finishedAt: null, error: null,
            errorCode: null, generatedPages: null, failedPages: null, retriedPage: null, attempts: null,
          }
        : null,
    },
    stale: false,
    runActive: serverRunActive,
  });
  const harness = await setup(async (url, init) => {
    const method = init?.method ?? 'GET';
    if (method === 'POST' && url.pathname.endsWith('/retry')) {
      retryPaths.push(url.pathname);
      serverRunActive = true;
      return Response.json({ retried: true });
    }
    if (method === 'POST' && url.pathname.endsWith('/stop')) {
      serverRunActive = false;
      return Response.json({ stopped: true });
    }
    if (method === 'GET' && url.pathname.startsWith('/api/repo-wiki/')) {
      return Response.json(statusPayload());
    }
    return null;
  });
  try {
    seed('/repo', entryWith({ status: { wiki: statusPayload().wiki, stale: false, runActive: false }, loaded: true }));
    await harness.render('/repo', false);

    const bulkButton = buttonByAria(harness.container, 'Retry failed pages');
    expect(bulkButton).toBeDefined();
    await act(async () => { bulkButton?.click(); });

    // The first page's retry reserves the run; the Stop button appears
    // (label text 'Stop' — the control carries no aria-label).
    await until(() => retryPaths.length === 1);
    await until(() => Array.from(harness.container.querySelectorAll('button'))
      .some((button) => button.textContent?.trim() === 'Stop'));
    const stop = Array.from(harness.container.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Stop');
    await act(async () => { stop?.click(); });

    // The loop breaks once the in-flight page settles — the second failed
    // page is never fired.
    await until(() => serverRunActive === false);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(retryPaths).toHaveLength(1);
  } finally {
    await harness.unmount();
  }
}, 15_000);
