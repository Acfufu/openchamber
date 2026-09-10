import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';

import { createRepoWikiStore, MANIFEST_FILE, REPO_WIKI_VERSION } from './store.js';

let dataDir;
let store;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-wiki-store-'));
  store = createRepoWikiStore({ dataDir });
});

const manifestOf = (overrides = {}) => ({
  projectId: 'path_abc',
  commit: 'a1b2c3',
  language: 'en',
  diagrams: true,
  run: { status: 'done' },
  catalog: { pages: [{ id: 'overview', title: 'Overview', status: 'done' }] },
  ...overrides,
});

describe('repo-wiki store', () => {
  it('round-trips a manifest and stamps the wiki version', async () => {
    await store.writeManifest('path_abc', manifestOf());
    const manifest = await store.readManifest('path_abc');
    expect(manifest).not.toBeNull();
    expect(manifest.wikiVersion).toBe(REPO_WIKI_VERSION);
    expect(manifest.commit).toBe('a1b2c3');
    expect(manifest.catalog.pages).toHaveLength(1);
  });

  it('reads a missing manifest as null', async () => {
    await expect(store.readManifest('path_absent')).resolves.toBeNull();
  });

  it('reads a corrupt manifest as null instead of throwing', async () => {
    const dir = path.join(dataDir, 'repo-wiki', 'path_broken');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, MANIFEST_FILE), '{ not json', 'utf8');
    await expect(store.readManifest('path_broken')).resolves.toBeNull();
  });

  it('rejects a manifest with a foreign wiki version', async () => {
    const dir = path.join(dataDir, 'repo-wiki', 'path_foreign');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify({ wikiVersion: 999 }), 'utf8');
    await expect(store.readManifest('path_foreign')).resolves.toBeNull();
  });

  it('round-trips page content and reads missing pages as null', async () => {
    await store.writePage('path_abc', 'overview', '# Overview\n\nBody.');
    await expect(store.readPage('path_abc', 'overview')).resolves.toBe('# Overview\n\nBody.');
    await expect(store.readPage('path_abc', 'missing')).resolves.toBeNull();
  });

  it('rejects projectIds and pageIds that could escape their directories', async () => {
    await expect(store.readManifest('../escape')).rejects.toThrow(/unsupported characters/);
    await expect(store.readPage('path_abc', 'a/b')).rejects.toThrow(/unsupported characters/);
    await expect(store.writePage('path_abc', 'a\\b', 'x')).rejects.toThrow(/unsupported characters/);
  });

  it('rejects empty page content', async () => {
    await expect(store.writePage('path_abc', 'overview', '')).rejects.toThrow(/non-empty string/);
  });

  it('deleteWiki removes the project subtree and nothing else', async () => {
    await store.writeManifest('path_abc', manifestOf());
    await store.writePage('path_abc', 'overview', '# Overview');
    await store.writeManifest('path_keep', manifestOf({ projectId: 'path_keep' }));

    await store.deleteWiki('path_abc');

    await expect(store.readManifest('path_abc')).resolves.toBeNull();
    await expect(store.readPage('path_abc', 'overview')).resolves.toBeNull();
    await expect(store.readManifest('path_keep')).resolves.not.toBeNull();
  });

  it('recoverInterruptedRuns marks running runs stopped and keeps finished pages', async () => {
    await store.writeManifest('path_running', manifestOf({
      run: { status: 'running', startedAt: '2026-01-01T00:00:00Z' },
    }));
    await store.writePage('path_running', 'overview', '# Overview');
    await store.writeManifest('path_done', manifestOf({ run: { status: 'done' } }));

    const recovered = await store.recoverInterruptedRuns();

    expect(recovered).toBe(1);
    const manifest = await store.readManifest('path_running');
    expect(manifest.run.status).toBe('stopped');
    expect(manifest.run.error).toMatch(/restart/);
    await expect(store.readPage('path_running', 'overview')).resolves.toBe('# Overview');
    const done = await store.readManifest('path_done');
    expect(done.run.status).toBe('done');
  });

  it('recoverInterruptedRuns tolerates a missing store root', async () => {
    const empty = createRepoWikiStore({ dataDir: path.join(dataDir, 'does-not-exist') });
    await expect(empty.recoverInterruptedRuns()).resolves.toBe(0);
  });
});
