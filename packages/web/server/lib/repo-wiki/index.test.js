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

const waitFor = async (predicate, timeoutMs = 2_000) => {
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

    // A retry that succeeds repairs the page.
    runtime = createRepoWikiRuntime({
      dataDir,
      readSettings: () => ({ defaultModel: 'test-provider/test-model' }),
      describeModel: async () => ({ ...describedModel }),
      modelCall: async () => markdownFor('internals'),
    });
    await runtime.retryPage({ projectId: 'path_iso', directory: repoRoot, pageId: 'internals' });
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
});
