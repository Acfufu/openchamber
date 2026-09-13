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

const storedWiki = (stale: boolean) => ({
  commit: 'a'.repeat(40),
  branch: 'main',
  language: 'English',
  diagrams: true,
  model: null,
  generatedAt: null,
  run: null,
  catalog: { pages: [donePage('p1', 'Overview'), donePage('p2', 'Conventions')] },
} satisfies RepoWikiStatus);

const entryWith = (patch: Partial<RepoWikiEntry>): RepoWikiEntry => ({ ...EMPTY_REPO_WIKI_ENTRY, ...patch });

interface Harness {
  container: HTMLElement;
  render: (directory: string, readOnly: boolean) => Promise<void>;
  unmount: () => Promise<void>;
}

/**
 * Boots happy-dom with the canonical globals, stubs fetch (the small-model
 * probe answers; repo-wiki reads stay pending so the seeded store state is
 * what renders), and mounts the panel through the REAL stores — the same
 * zustand modules the app uses, seeded with setState.
 */
const setup = async (): Promise<Harness> => {
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
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    if (url.pathname === '/api/small-model') return Response.json({ authenticatedProviders: [] });
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
  seed('/repo', entryWith({ status: { wiki: storedWiki(false), stale: false, runActive: false }, loaded: true }));
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
  seed('/repo', entryWith({ status: { wiki: storedWiki(true), stale: true, runActive: false }, loaded: true }));
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
