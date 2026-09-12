import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { registerRepoWikiRoutes } from './routes.js';

/**
 * Route tests over real HTTP on a bare express app — production has no global
 * JSON parser on /api prefixes, so a write whose parser is missing must fail
 * here, not in the product.
 */
const statusPayload = {
  wiki: { commit: 'abc', run: { status: 'done' }, catalog: { pages: [] } },
  stale: false,
  runActive: false,
};

const createApp = (runtimeOverrides = {}) => {
  const runtime = {
    listWikis: async () => ({ wikis: [] }),
    getStatus: async () => statusPayload,
    readPage: async ({ pageId }) => (pageId === 'overview' ? '# Overview' : null),
    startGeneration: async () => ({ started: true }),
    stopGeneration: async () => ({ stopped: false }),
    requestRetry: async ({ pageId }) => {
      if (pageId === 'not-failed') {
        throw Object.assign(new Error('Only a failed page can be retried — regenerate the wiki instead'), {
          statusCode: 409,
          code: 'page-not-failed',
        });
      }
      return { retried: true, pageId };
    },
    deleteWiki: async () => ({ deleted: true }),
    ...runtimeOverrides,
  };

  const app = express();
  // Deliberately no global express.json(): production parses only allowlisted
  // prefixes, and the routes attach their own parser per write route.
  registerRepoWikiRoutes(app, { repoWikiRuntime: runtime });
  return { app };
};

describe('repo-wiki routes', () => {
  it('returns status for a valid project and directory', async () => {
    const { app } = createApp();
    const response = await request(app).get('/api/repo-wiki/path_abc?directory=/tmp/repo');
    expect(response.status).toBe(200);
    expect(response.body.wiki.commit).toBe('abc');
    expect(response.body.stale).toBe(false);
  });

  it('rejects a malformed project id with 400', async () => {
    const { app } = createApp();
    const response = await request(app).get('/api/repo-wiki/..%2Fescape?directory=/tmp/repo');
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('invalid-project-id');
  });

  it('never serves or deletes through bare dot-segment project ids', async () => {
    const { app } = createApp();
    // Express 5 normalizes dot-only path segments during routing, so these
    // never reach the handler carrying `.`/`..`; whichever layer answers —
    // our id guard, the router's own 404, or the switcher list (a single
    // dot collapses onto the bare path, which takes no project input) —
    // no project payload may come back, and deletion must be rejected.
    for (const encoded of ['%2e%2e', '%2e']) {
      const read = await request(app).get(`/api/repo-wiki/${encoded}?directory=/tmp/repo`);
      expect([200, 400, 404], `GET ${encoded}`).toContain(read.status);
      expect(read.body.wiki, encoded).toBeUndefined();
      const deleted = await request(app).delete(`/api/repo-wiki/${encoded}`);
      expect([400, 404], `DELETE ${encoded}`).toContain(deleted.status);
      expect(deleted.body.deleted, encoded).toBeUndefined();
    }
  });

  it('serves status without a directory query, omitting staleness', async () => {
    const { app } = createApp({
      getStatus: async ({ directory }) => ({
        wiki: { commit: 'abc', run: { status: 'done' }, catalog: { pages: [] } },
        ...(directory ? { stale: true } : {}),
        runActive: false,
      }),
    });
    const cross = await request(app).get('/api/repo-wiki/path_abc');
    expect(cross.status).toBe(200);
    expect(cross.body.wiki.commit).toBe('abc');
    expect('stale' in cross.body).toBe(false);

    const direct = await request(app).get('/api/repo-wiki/path_abc?directory=/tmp/repo');
    expect(direct.status).toBe(200);
    expect(direct.body.stale).toBe(true);
  });

  it('lists stored wikis for the switcher', async () => {
    const { app } = createApp({
      listWikis: async () => ({
        wikis: [{ projectId: 'path_abc', language: 'en', pagesDone: 2, pagesFailed: 1, run: { status: 'done', stage: 'done' } }],
      }),
    });
    const response = await request(app).get('/api/repo-wiki');
    expect(response.status).toBe(200);
    expect(response.body.wikis).toHaveLength(1);
    expect(response.body.wikis[0].projectId).toBe('path_abc');
  });

  it('answers unknown pages with 404 JSON', async () => {
    const { app } = createApp();
    const response = await request(app).get('/api/repo-wiki/path_abc/pages/nope');
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('unknown-page');
  });

  it('serves page markdown', async () => {
    const { app } = createApp();
    const response = await request(app).get('/api/repo-wiki/path_abc/pages/overview');
    expect(response.status).toBe(200);
    expect(response.body.markdown).toBe('# Overview');
  });

  it('parses generate bodies and starts a run', async () => {
    const seen = {};
    const { app } = createApp({
      startGeneration: async ({ projectId, directory, options }) => {
        seen.projectId = projectId;
        seen.directory = directory;
        seen.options = options;
        return { started: true };
      },
    });
    const response = await request(app)
      .post('/api/repo-wiki/path_abc/generate')
      .send({ directory: '/tmp/repo', language: 'zh-CN', diagrams: false, model: 'p/m' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ started: true });
    expect(seen.directory).toBe('/tmp/repo');
    expect(seen.options).toEqual({ language: 'zh-CN', model: 'p/m', diagrams: false });
  });

  it('rejects a generate body without directory', async () => {
    const { app } = createApp();
    const response = await request(app).post('/api/repo-wiki/path_abc/generate').send({});
    expect(response.status).toBe(400);
  });

  it('passes retries through and maps the invalid-retries refusal to 400', async () => {
    const seen = {};
    const { app } = createApp({
      startGeneration: async ({ options }) => {
        // Mirror the runtime's contract boundary for the mapping test.
        if (options.retries != null && (!Number.isInteger(options.retries) || options.retries < 0 || options.retries > 3)) {
          throw Object.assign(new Error('retries must be an integer between 0 and 3'), {
            statusCode: 400,
            code: 'invalid-retries',
          });
        }
        seen.retries = options.retries;
        return { started: true };
      },
    });

    const bad = await request(app)
      .post('/api/repo-wiki/path_abc/generate')
      .send({ directory: '/tmp/repo', retries: 9 });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid-retries');

    const ok = await request(app)
      .post('/api/repo-wiki/path_abc/generate')
      .send({ directory: '/tmp/repo', retries: 2 });
    expect(ok.status).toBe(200);
    expect(seen.retries).toBe(2);
  });

  it('maps the retry route invalid-retries refusal to 400', async () => {
    const { app } = createApp({
      requestRetry: async () => {
        throw Object.assign(new Error('retries must be an integer between 0 and 3'), {
          statusCode: 400,
          code: 'invalid-retries',
        });
      },
    });
    const response = await request(app)
      .post('/api/repo-wiki/path_abc/pages/overview/retry')
      .send({ directory: '/tmp/repo', retries: 'many' });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('invalid-retries');
  });

  it('maps runtime error status codes onto the response', async () => {
    const { app } = createApp({
      startGeneration: async () => {
        throw Object.assign(new Error('No model available — pick a model for this wiki'), {
          statusCode: 404,
          code: 'no-model',
        });
      },
    });
    const response = await request(app)
      .post('/api/repo-wiki/path_abc/generate')
      .send({ directory: '/tmp/repo' });
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('no-model');
  });

  it('maps context-too-small refusals with their numbers', async () => {
    const { app } = createApp({
      startGeneration: async () => {
        throw Object.assign(new Error('Input is too large'), {
          statusCode: 409,
          code: 'context-too-small',
          requiredChars: 90_000,
          availableChars: 60_000,
        });
      },
    });
    const response = await request(app)
      .post('/api/repo-wiki/path_abc/generate')
      .send({ directory: '/tmp/repo' });
    expect(response.status).toBe(409);
    expect(response.body.requiredChars).toBe(90_000);
    expect(response.body.availableChars).toBe(60_000);
  });

  it('maps a non-retryable page to 409', async () => {
    const { app } = createApp();
    const response = await request(app)
      .post('/api/repo-wiki/path_abc/pages/not-failed/retry')
      .send({ directory: '/tmp/repo' });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('page-not-failed');
  });

  it('deletes a wiki', async () => {
    const { app } = createApp();
    const response = await request(app).delete('/api/repo-wiki/path_abc');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ deleted: true });
  });

  it('stops a run', async () => {
    const { app } = createApp();
    const response = await request(app).post('/api/repo-wiki/path_abc/stop');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ stopped: false });
  });

  it('answers unclaimed subpaths with our 404 JSON, never proxy HTML', async () => {
    const { app } = createApp();
    // `/api/repo-wiki` itself is claimed (the switcher list); only unclaimed
    // subpaths fall through to the guard.
    for (const path of ['/api/repo-wiki/path_abc/not-a-thing', '/api/repo-wiki/path_abc/pages/overview/extra']) {
      const response = await request(app).get(path);
      expect(response.status, path).toBe(404);
      expect(response.headers['content-type'], path).toMatch(/application\/json/);
      expect(response.text, path).not.toMatch(/<html/i);
    }
  });
});
