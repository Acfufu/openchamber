import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepoWikiRuntime } from './index.js';

let dataDir;
let repoRoot;
let runtime;

const git = (args) => {
  execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
};

const write = (relative, content) => {
  const absolute = path.join(repoRoot, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, 'utf8');
};

const seedRepo = () => {
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  write('README.md', '# Fixture\n\nA test repository.');
  write('src/index.js', 'export const main = () => 1;\n');
  git(['add', '.']);
  git(['commit', '-qm', 'fixture']);
};

const describedModel = {
  providerID: 'test-provider',
  modelID: 'test-model',
  hasLogin: true,
  inputCharBudget: 200_000,
  outputTokens: 8_192,
  structuredOutput: true,
};

const catalogResponse = {
  pages: [
    { id: 'overview', title: 'Overview', purpose: 'What this is', files: ['README.md'], diagram: null },
    { id: 'internals', title: 'Internals', purpose: 'How it works', files: ['src/index.js'], diagram: 'flow' },
  ],
};

const markdownFor = (pageId) => ({
  text: JSON.stringify({ markdown: `# ${pageId}\n\nSee [index](repo-wiki-src://src%2Findex.js#L1-L1).` }),
});

const inject = ({ modelCall }) => {
  runtime = createRepoWikiRuntime({
    dataDir,
    readSettings: () => ({ defaultModel: 'test-provider/test-model' }),
    describeModel: async () => ({ ...describedModel }),
    modelCall,
  });
};

const waitFor = async (predicate, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for run condition');
};

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-wiki-runtime-'));
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-wiki-repo-'));
  seedRepo();
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('repo-wiki runtime', () => {
  it('runs a full generation: catalog lands, pages stream, files persist', async () => {
    const calls = [];
    inject({
      modelCall: async ({ system, prompt, responseSchema }) => {
        calls.push({ system, prompt, responseSchema });
        if (prompt.includes('Repository digest:')) {
          return { text: JSON.stringify(catalogResponse) };
        }
        const pageId = prompt.includes('Page to write: Internals') ? 'internals' : 'overview';
        return markdownFor(pageId);
      },
    });

    await runtime.recover();
    const started = await runtime.startGeneration({ projectId: 'path_fix', directory: repoRoot, options: {} });
    expect(started.started).toBe(true);
    expect(started.model).toEqual({ providerID: 'test-provider', modelID: 'test-model' });

    await waitFor(async () => (await runtime.getStatus({ projectId: 'path_fix', directory: repoRoot })).wiki?.run?.status === 'done');

    const status = await runtime.getStatus({ projectId: 'path_fix', directory: repoRoot });
    expect(status.stale).toBe(false);
    expect(status.wiki.catalog.pages.map((page) => page.status)).toEqual(['done', 'done']);
    expect(status.wiki.commit).toBeTruthy();
    expect(status.wiki.branch).toBeTruthy();

    const overview = await runtime.readPage({ projectId: 'path_fix', pageId: 'overview' });
    expect(overview).toContain('# overview');
    expect(await runtime.readPage({ projectId: 'path_fix', pageId: 'internals' })).toContain('repo-wiki-src://');
    expect(calls[0].responseSchema).toBeTruthy();
  });

  it('stops between pages and keeps finished pages', async () => {
    inject({
      modelCall: async ({ prompt, signal }) => {
        if (prompt.includes('Repository digest:')) {
          return { text: JSON.stringify(catalogResponse) };
        }
        // Block the second page until the run's abort signal fires, like a
        // real in-flight model call would.
        if (prompt.includes('Page to write: Internals')) {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve(markdownFor('internals')), 5_000);
            signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            });
          });
        }
        return markdownFor('overview');
      },
    });

    await runtime.startGeneration({ projectId: 'path_stop', directory: repoRoot, options: { language: 'en' } });

    // Once the first page is done, request a stop.
    await waitFor(async () => {
      const status = await runtime.getStatus({ projectId: 'path_stop', directory: repoRoot });
      return status.wiki?.catalog?.pages?.[0]?.status === 'done';
    });
    await runtime.stopGeneration({ projectId: 'path_stop' });

    await waitFor(async () => (await runtime.getStatus({ projectId: 'path_stop', directory: repoRoot })).wiki?.run?.status === 'stopped');
    const status = await runtime.getStatus({ projectId: 'path_stop', directory: repoRoot });
    expect(status.wiki.catalog.pages[0].status).toBe('done');
    expect(status.wiki.catalog.pages[1].status).toBe('pending');
    expect(await runtime.readPage({ projectId: 'path_stop', pageId: 'overview' })).toBeTruthy();
  });

  it('stop wins during a retry budget: no second attempt after the abort', async () => {
    let internalsCalls = 0;
    inject({
      modelCall: async ({ prompt, signal }) => {
        if (prompt.includes('Repository digest:')) {
          return { text: JSON.stringify(catalogResponse) };
        }
        if (prompt.includes('Page to write: Internals')) {
          internalsCalls += 1;
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve(markdownFor('internals')), 5_000);
            signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            });
          });
        }
        return markdownFor('overview');
      },
    });

    await runtime.startGeneration({ projectId: 'path_stop_wait', directory: repoRoot, options: { retries: 1 } });
    await waitFor(async () => {
      const status = await runtime.getStatus({ projectId: 'path_stop_wait', directory: repoRoot });
      return status.wiki?.catalog?.pages?.[0]?.status === 'done';
    });
    await runtime.stopGeneration({ projectId: 'path_stop_wait' });

    await waitFor(async () => (await runtime.getStatus({ projectId: 'path_stop_wait', directory: repoRoot })).wiki?.run?.status === 'stopped');
    const status = await runtime.getStatus({ projectId: 'path_stop_wait', directory: repoRoot });
    expect(status.wiki.catalog.pages[1].status).toBe('pending');
    expect(internalsCalls).toBe(1);
  });

  it('stop wins during the pause between retry attempts', async () => {
    let internalsCalls = 0;
    inject({
      modelCall: async ({ prompt }) => {
        if (prompt.includes('Repository digest:')) {
          return { text: JSON.stringify(catalogResponse) };
        }
        if (prompt.includes('Page to write: Internals')) {
          internalsCalls += 1;
          throw Object.assign(new Error('model exploded'), { statusCode: 500 });
        }
        return markdownFor('overview');
      },
    });

    await runtime.startGeneration({ projectId: 'path_stop_delay', directory: repoRoot, options: { retries: 3 } });

    // The first Internals attempt just failed; the run is now inside the
    // fixed pause before the second attempt. Land the stop inside it.
    await waitFor(() => internalsCalls === 1);
    await runtime.stopGeneration({ projectId: 'path_stop_delay' });

    await waitFor(async () => (await runtime.getStatus({ projectId: 'path_stop_delay', directory: repoRoot })).wiki?.run?.status === 'stopped');
    const status = await runtime.getStatus({ projectId: 'path_stop_delay', directory: repoRoot });
    expect(status.wiki.catalog.pages[1].status).toBe('pending');
    expect(internalsCalls).toBe(1);
  });

  it('retries a failed page call in place and records the attempts', async () => {
    let internalsCalls = 0;
    inject({
      modelCall: async ({ prompt }) => {
        if (prompt.includes('Repository digest:')) {
          return { text: JSON.stringify(catalogResponse) };
        }
        if (prompt.includes('Page to write: Internals')) {
          internalsCalls += 1;
          if (internalsCalls === 1) {
            throw Object.assign(new Error('model exploded'), { statusCode: 500 });
          }
          return markdownFor('internals');
        }
        return markdownFor('overview');
      },
    });

    await runtime.startGeneration({ projectId: 'path_retry', directory: repoRoot, options: { retries: 3 } });
    await waitFor(async () => (await runtime.getStatus({ projectId: 'path_retry', directory: repoRoot })).wiki?.run?.status === 'done');

    const status = await runtime.getStatus({ projectId: 'path_retry', directory: repoRoot });
    expect(status.wiki.catalog.pages[1].status).toBe('done');
    // One overview call + two internals attempts.
    expect(status.wiki.run.attempts).toBe(3);
    expect(internalsCalls).toBe(2);
  });

  it('rejects out-of-range and non-integer retry budgets', async () => {
    inject({ modelCall: async () => markdownFor('overview') });
    await expect(runtime.startGeneration({ projectId: 'path_bad_retries', directory: repoRoot, options: { retries: 4 } }))
      .rejects.toMatchObject({ code: 'invalid-retries', statusCode: 400 });
    await expect(runtime.startGeneration({ projectId: 'path_bad_retries', directory: repoRoot, options: { retries: 1.5 } }))
      .rejects.toMatchObject({ code: 'invalid-retries', statusCode: 400 });
    await expect(runtime.requestRetry({ projectId: 'path_bad_retries', directory: repoRoot, pageId: 'overview', retries: -1 }))
      .rejects.toMatchObject({ code: 'invalid-retries', statusCode: 400 });
  });

  it('isolates a failing page: others finish, run is done, page is retryable', async () => {
    inject({
      modelCall: async ({ prompt }) => {
        if (prompt.includes('Repository digest:')) {
          return { text: JSON.stringify(catalogResponse) };
        }
        if (prompt.includes('Page to write: Internals')) {
          throw Object.assign(new Error('model exploded'), { statusCode: 500 });
        }
        return markdownFor('overview');
      },
    });

    await runtime.startGeneration({ projectId: 'path_iso', directory: repoRoot, options: {} });
    await waitFor(async () => (await runtime.getStatus({ projectId: 'path_iso', directory: repoRoot })).wiki?.run?.status === 'done');

    const status = await runtime.getStatus({ projectId: 'path_iso', directory: repoRoot });
    expect(status.wiki.catalog.pages[0].status).toBe('done');
    expect(status.wiki.catalog.pages[1].status).toBe('failed');
    expect(status.wiki.run.status).toBe('done');

    // A retry that succeeds repairs the page (background job — poll for it).
    runtime = createRepoWikiRuntime({
      dataDir,
      readSettings: () => ({ defaultModel: 'test-provider/test-model' }),
      describeModel: async () => ({ ...describedModel }),
      modelCall: async () => markdownFor('internals'),
    });
    await runtime.requestRetry({ projectId: 'path_iso', directory: repoRoot, pageId: 'internals' });
    await waitFor(async () => (await runtime.readPage({ projectId: 'path_iso', pageId: 'internals' })) !== null);
    expect(await runtime.readPage({ projectId: 'path_iso', pageId: 'internals' })).toContain('# internals');
  });

  it('marks the run failed only when every page fails', async () => {
    inject({
      modelCall: async ({ prompt }) => {
        if (prompt.includes('Repository digest:')) {
          return { text: JSON.stringify(catalogResponse) };
        }
        throw Object.assign(new Error('model exploded'), { statusCode: 500 });
      },
    });

    await runtime.startGeneration({ projectId: 'path_fail', directory: repoRoot, options: {} });
    await waitFor(async () => (await runtime.getStatus({ projectId: 'path_fail', directory: repoRoot })).wiki?.run?.status === 'failed');

    const status = await runtime.getStatus({ projectId: 'path_fail', directory: repoRoot });
    expect(status.wiki.catalog.pages.every((page) => page.status === 'failed')).toBe(true);
  });

  it('falls back to prompt-side JSON once when the provider refuses schemas, then remembers', async () => {
    let schemaAttempts = 0;
    const callLog = [];
    inject({
      modelCall: async ({ system, responseSchema }) => {
        callLog.push({ hasSchema: Boolean(responseSchema) });
        if (responseSchema) {
          schemaAttempts += 1;
          throw Object.assign(new Error('schema unsupported'), { statusCode: 400, code: 'structured-output-unsupported' });
        }
        // The fallback call carries the format instruction and no schema.
        if (!system.includes('ONLY a JSON object')) {
          throw new Error('fallback must describe the response format');
        }
        if (system.includes('You write one page')) {
          return markdownFor('overview');
        }
        return { text: JSON.stringify(catalogResponse) };
      },
    });

    await runtime.startGeneration({ projectId: 'path_schema', directory: repoRoot, options: {} });
    await waitFor(async () => (await runtime.getStatus({ projectId: 'path_schema', directory: repoRoot })).wiki?.run?.status === 'done');
    // Exactly one schema-shaped attempt ever failed; every later call — the
    // catalog fallback and both pages — skipped the schema from the memo.
    expect(schemaAttempts).toBe(1);
    expect(callLog[0].hasSchema).toBe(true);
    expect(callLog.slice(1).every((entry) => !entry.hasSchema)).toBe(true);
  });

  it('falls back for provider-shaped HTTP 4xx errors that carry `status`, not `statusCode`', async () => {
    let sawSchema = false;
    inject({
      // Mirrors small-model call.js httpError: `status`, provider label, no code.
      modelCall: async ({ responseSchema, system }) => {
        if (responseSchema) {
          sawSchema = true;
          throw Object.assign(new Error('DeepSeek request failed with 400: response_format unavailable'), {
            status: 400,
            provider: 'DeepSeek',
          });
        }
        if (system.includes('You write one page')) {
          return markdownFor('overview');
        }
        return { text: JSON.stringify(catalogResponse) };
      },
    });

    await runtime.startGeneration({ projectId: 'path_status_shape', directory: repoRoot, options: {} });
    await waitFor(async () => (await runtime.getStatus({ projectId: 'path_status_shape', directory: repoRoot })).wiki?.run?.status === 'done');
    expect(sawSchema).toBe(true);
    const status = await runtime.getStatus({ projectId: 'path_status_shape', directory: repoRoot });
    expect(status.wiki?.run?.status).toBe('done');
  });

  it('rejects a second generation while one is running', async () => {
    inject({
      modelCall: async ({ prompt }) => {
        if (prompt.includes('Repository digest:')) {
          return { text: JSON.stringify(catalogResponse) };
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
        return markdownFor('overview');
      },
    });

    const first = runtime.startGeneration({ projectId: 'path_lock', directory: repoRoot, options: {} });
    await expect(first).resolves.toMatchObject({ started: true });
    await expect(runtime.startGeneration({ projectId: 'path_lock', directory: repoRoot, options: {} }))
      .rejects.toMatchObject({ code: 'run-in-progress', statusCode: 409 });
    await waitFor(async () => (await runtime.getStatus({ projectId: 'path_lock', directory: repoRoot })).wiki?.run?.status === 'done');
  });

  it('reserves the run slot before the first await, so an overlapping start 409s', async () => {
    inject({
      modelCall: async ({ prompt }) => {
        if (prompt.includes('Repository digest:')) {
          return { text: JSON.stringify(catalogResponse) };
        }
        await new Promise((resolve) => setTimeout(resolve, 120));
        return markdownFor('overview');
      },
    });

    // Fired before the first request has awaited anything: only a
    // reserve-before-await order can reject this.
    const first = runtime.startGeneration({ projectId: 'path_lock_race', directory: repoRoot, options: {} });
    await expect(runtime.startGeneration({ projectId: 'path_lock_race', directory: repoRoot, options: {} }))
      .rejects.toMatchObject({ code: 'run-in-progress', statusCode: 409 });
    await expect(first).resolves.toMatchObject({ started: true });

    // The surviving run is the one stop can abort.
    await runtime.stopGeneration({ projectId: 'path_lock_race' });
    await waitFor(async () => (await runtime.getStatus({ projectId: 'path_lock_race', directory: repoRoot })).wiki?.run?.status === 'stopped');
  });

  it('marks the run stopped — not failed — when the stop lands during the catalog call', async () => {
    inject({
      modelCall: async ({ prompt, signal }) => {
        if (prompt.includes('Repository digest:')) {
          await new Promise((resolve, reject) => {
            const abort = () => {
              clearTimeout(timer);
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            };
            const timer = setTimeout(() => resolve({ text: JSON.stringify(catalogResponse) }), 5_000);
            if (signal?.aborted) {
              abort();
              return;
            }
            signal?.addEventListener('abort', abort);
          });
        }
        return markdownFor('overview');
      },
    });

    await runtime.startGeneration({ projectId: 'path_stop_catalog', directory: repoRoot, options: {} });
    await runtime.stopGeneration({ projectId: 'path_stop_catalog' });

    await waitFor(async () => (await runtime.getStatus({ projectId: 'path_stop_catalog', directory: repoRoot })).wiki?.run?.status === 'stopped');
    const status = await runtime.getStatus({ projectId: 'path_stop_catalog', directory: repoRoot });
    expect(status.wiki?.run?.error).toBeFalsy();
    expect(status.wiki?.run?.errorCode).toBeFalsy();
  });

  it('reports stale when the workspace HEAD moved past the recorded commit', async () => {
    inject({
      modelCall: async ({ prompt }) => (prompt.includes('Repository digest:')
        ? { text: JSON.stringify(catalogResponse) }
        : markdownFor('overview')),
    });

    await runtime.startGeneration({ projectId: 'path_stale', directory: repoRoot, options: {} });
    await waitFor(async () => (await runtime.getStatus({ projectId: 'path_stale', directory: repoRoot })).wiki?.run?.status === 'done');

    write('src/extra.js', 'export const extra = 1;\n');
    git(['add', '.']);
    git(['commit', '-qm', 'move on']);

    const status = await runtime.getStatus({ projectId: 'path_stale', directory: repoRoot });
    expect(status.stale).toBe(true);
  });

  it('fails with no-model when no source names a model', async () => {
    runtime = createRepoWikiRuntime({
      dataDir,
      readSettings: () => ({}),
      describeModel: async () => ({ ...describedModel }),
      modelCall: async () => markdownFor('overview'),
    });

    await expect(runtime.startGeneration({ projectId: 'path_nomodel', directory: repoRoot, options: {} }))
      .rejects.toMatchObject({ code: 'no-model', statusCode: 404 });
  });

  it('prefers the request model over the manifest and settings', async () => {
    const described = [];
    runtime = createRepoWikiRuntime({
      dataDir,
      readSettings: () => ({ defaultModel: 'settings-provider/settings-model' }),
      describeModel: async ({ model }) => {
        described.push(model);
        return { ...describedModel, providerID: model.providerID, modelID: model.modelID };
      },
      modelCall: async ({ prompt }) => (prompt.includes('Repository digest:')
        ? { text: JSON.stringify(catalogResponse) }
        : markdownFor('overview')),
    });

    await runtime.startGeneration({
      projectId: 'path_chain',
      directory: repoRoot,
      options: { model: 'request-provider/request-model' },
    });
    await waitFor(async () => (await runtime.getStatus({ projectId: 'path_chain', directory: repoRoot })).wiki?.run?.status === 'done');
    expect(described[0]).toEqual({ providerID: 'request-provider', modelID: 'request-model' });
    expect((await runtime.getStatus({ projectId: 'path_chain', directory: repoRoot })).wiki.model)
      .toEqual({ providerID: 'request-provider', modelID: 'request-model' });

    // Regeneration without a request falls back to the manifest's model —
    // one more describeModel call, again the request-time model.
    const describedBefore = described.length;
    await runtime.startGeneration({ projectId: 'path_chain', directory: repoRoot, options: {} });
    await waitFor(async () => described.length > describedBefore
      && (await runtime.getStatus({ projectId: 'path_chain', directory: repoRoot })).wiki?.run?.status === 'done');
    expect(described[described.length - 1]).toEqual({ providerID: 'request-provider', modelID: 'request-model' });
  });

  it('refuses to delete or retry while a run is active, and delete clears storage', async () => {
    inject({
      modelCall: async ({ prompt }) => {
        if (prompt.includes('Repository digest:')) {
          return { text: JSON.stringify(catalogResponse) };
        }
        await new Promise((resolve) => setTimeout(resolve, 120));
        return markdownFor('overview');
      },
    });

    await runtime.startGeneration({ projectId: 'path_del', directory: repoRoot, options: {} });
    await expect(runtime.deleteWiki({ projectId: 'path_del' })).rejects.toMatchObject({ code: 'run-in-progress' });
    await waitFor(async () => (await runtime.getStatus({ projectId: 'path_del', directory: repoRoot })).wiki?.run?.status === 'done');

    await expect(runtime.deleteWiki({ projectId: 'path_del' })).resolves.toEqual({ deleted: true });
    expect((await runtime.getStatus({ projectId: 'path_del', directory: repoRoot })).wiki).toBeNull();
  });

  it('lists stored wikis across projects and skips unreadable manifests', async () => {
    inject({
      modelCall: async ({ prompt }) => (prompt.includes('Repository digest:')
        ? { text: JSON.stringify(catalogResponse) }
        : markdownFor('overview')),
    });

    await runtime.startGeneration({ projectId: 'path_list_a', directory: repoRoot, options: {} });
    await waitFor(async () => (await runtime.getStatus({ projectId: 'path_list_a', directory: repoRoot })).wiki?.run?.status === 'done');

    await runtime.store.writeManifest('path_list_b', {
      projectId: 'path_list_b',
      commit: 'def456',
      branch: 'dev',
      language: 'de',
      catalog: { pages: [{ id: 'x', status: 'done' }, { id: 'y', status: 'failed' }] },
      run: { status: 'done', stage: 'done', startedAt: 't0', finishedAt: 't1' },
    });
    // A stray non-manifest entry in the store root must not break the listing.
    fs.writeFileSync(path.join(runtime.store.rootDir, 'notes.txt'), 'not a manifest', 'utf8');

    const list = await runtime.listWikis();
    expect(list.wikis).toHaveLength(2);
    const byId = new Map(list.wikis.map((entry) => [entry.projectId, entry]));
    expect(byId.get('path_list_b')).toMatchObject({
      branch: 'dev',
      language: 'de',
      pagesDone: 1,
      pagesFailed: 1,
      updatedAt: 't1',
      run: { status: 'done', stage: 'done' },
    });
    expect(byId.get('path_list_a')?.pagesDone).toBe(2);
  });

  it('answers status without a directory by omitting staleness', async () => {
    inject({
      modelCall: async ({ prompt }) => (prompt.includes('Repository digest:')
        ? { text: JSON.stringify(catalogResponse) }
        : markdownFor('overview')),
    });

    await runtime.startGeneration({ projectId: 'path_nodir', directory: repoRoot, options: {} });
    await waitFor(async () => (await runtime.getStatus({ projectId: 'path_nodir', directory: repoRoot })).wiki?.run?.status === 'done');

    const cross = await runtime.getStatus({ projectId: 'path_nodir' });
    expect(cross.wiki?.commit).toBeTruthy();
    expect('stale' in cross).toBe(false);
  });

  it('boot recovery reclassifies pages stuck in writing as failed/interrupted, retryable again', async () => {
    inject({
      modelCall: async ({ prompt }) => {
        if (prompt.includes('Repository digest:')) {
          return { text: JSON.stringify(catalogResponse) };
        }
        if (prompt.includes('Page to write: Internals')) {
          throw Object.assign(new Error('model exploded'), { statusCode: 500 });
        }
        return markdownFor('overview');
      },
    });

    await runtime.startGeneration({ projectId: 'path_recover', directory: repoRoot, options: {} });
    await waitFor(async () => (await runtime.getStatus({ projectId: 'path_recover', directory: repoRoot })).wiki?.run?.status === 'done');

    // Simulate the crash aftermath the store's run recovery cannot see: the
    // run was already recovered to stopped, but a page died mid-call and its
    // manifest entry still says `writing`.
    const manifest = await runtime.store.readManifest('path_recover');
    manifest.catalog.pages[1].status = 'writing';
    await runtime.store.writeManifest('path_recover', manifest);

    expect(await runtime.recover()).toBe(1);

    const status = await runtime.getStatus({ projectId: 'path_recover', directory: repoRoot });
    expect(status.wiki.catalog.pages[1].status).toBe('failed');
    expect(status.wiki.catalog.pages[1].errorCode).toBe('interrupted');

    // The reclassified page is individually retryable again.
    runtime = createRepoWikiRuntime({
      dataDir,
      readSettings: () => ({ defaultModel: 'test-provider/test-model' }),
      describeModel: async () => ({ ...describedModel }),
      modelCall: async () => markdownFor('internals'),
    });
    await runtime.recover();
    await runtime.requestRetry({ projectId: 'path_recover', directory: repoRoot, pageId: 'internals' });
    await waitFor(async () => (await runtime.getStatus({ projectId: 'path_recover', directory: repoRoot })).wiki?.run?.status === 'done');
    expect((await runtime.getStatus({ projectId: 'path_recover', directory: repoRoot })).wiki.catalog.pages[1].status).toBe('done');
  });
});
