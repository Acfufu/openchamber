import express from 'express';

import { isValidPageId, isValidProjectId } from './store.js';

const readStringOption = (value) => {
  if (value == null || value.constructor !== String) return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
};

const readQueryDirectory = (req) => readStringOption(req.query.directory);

const readBodyDirectory = (body) => readStringOption(body?.directory);

/**
 * Repo Wiki HTTP surface. Registered before the OpenCode proxy so unclaimed
 * `/api/repo-wiki/*` paths answer our 404 JSON — the proxy would otherwise
 * forward them upstream, which answers unknown paths with 200 HTML.
 */
export function registerRepoWikiRoutes(app, { repoWikiRuntime }) {
  const respondWithError = (res, error, fallback) => {
    const statusCode = Number(error?.statusCode) || 500;
    if (statusCode >= 500) {
      console.error(`${fallback}:`, error);
    }
    const payload = { error: error?.message || fallback };
    if (error?.code) payload.code = error.code;
    if (Number.isFinite(error?.requiredChars)) payload.requiredChars = error.requiredChars;
    if (Number.isFinite(error?.availableChars)) payload.availableChars = error.availableChars;
    res.status(statusCode).json(payload);
  };

  const requireProjectId = (req, res) => {
    const { projectId } = req.params;
    if (!isValidProjectId(projectId)) {
      res.status(400).json({ error: 'projectId contains unsupported characters', code: 'invalid-project-id' });
      return null;
    }
    return projectId;
  };

  const requirePageId = (req, res) => {
    const { pageId } = req.params;
    if (!isValidPageId(pageId)) {
      res.status(400).json({ error: 'pageId contains unsupported characters', code: 'invalid-page-id' });
      return null;
    }
    return pageId;
  };

  const requireDirectory = (req, res) => {
    const directory = readQueryDirectory(req);
    if (!directory) {
      res.status(400).json({ error: 'directory parameter is required' });
      return null;
    }
    return directory;
  };

  app.get('/api/repo-wiki/:projectId', async (req, res) => {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const directory = requireDirectory(req, res);
    if (!directory) return;
    try {
      res.json(await repoWikiRuntime.getStatus({ projectId, directory }));
    } catch (error) {
      respondWithError(res, error, 'Failed to read Repo Wiki status');
    }
  });

  app.get('/api/repo-wiki/:projectId/pages/:pageId', async (req, res) => {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const pageId = requirePageId(req, res);
    if (!pageId) return;
    try {
      const markdown = await repoWikiRuntime.readPage({ projectId, pageId });
      if (markdown == null) {
        return res.status(404).json({ error: 'Page not found', code: 'unknown-page' });
      }
      return res.json({ pageId, markdown });
    } catch (error) {
      return respondWithError(res, error, 'Failed to read Repo Wiki page');
    }
  });

  app.post('/api/repo-wiki/:projectId/generate', express.json(), async (req, res) => {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const directory = readBodyDirectory(req.body);
    if (!directory) {
      return res.status(400).json({ error: 'directory is required' });
    }
    const body = req.body || {};
    const options = {
      language: readStringOption(body.language),
      model: readStringOption(body.model),
    };
    options.diagrams = body.diagrams == null ? undefined : body.diagrams === true;
    // Raw pass-through: the runtime owns the retries contract (default 0,
    // integer 0-3) and answers 400 `invalid-retries` for anything else.
    if (body.retries != null) options.retries = body.retries;
    try {
      return res.json(await repoWikiRuntime.startGeneration({ projectId, directory, options }));
    } catch (error) {
      return respondWithError(res, error, 'Failed to start Repo Wiki generation');
    }
  });

  app.post('/api/repo-wiki/:projectId/stop', async (req, res) => {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    try {
      res.json(await repoWikiRuntime.stopGeneration({ projectId }));
    } catch (error) {
      respondWithError(res, error, 'Failed to stop Repo Wiki generation');
    }
  });

  app.post('/api/repo-wiki/:projectId/pages/:pageId/retry', express.json(), async (req, res) => {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    const pageId = requirePageId(req, res);
    if (!pageId) return;
    const directory = readBodyDirectory(req.body);
    if (!directory) {
      return res.status(400).json({ error: 'directory is required' });
    }
    const body = req.body || {};
    try {
      // Same raw pass-through as generate: the runtime owns the retries
      // contract and answers 400 `invalid-retries`.
      return res.json(await repoWikiRuntime.requestRetry({ projectId, directory, pageId, retries: body.retries }));
    } catch (error) {
      return respondWithError(res, error, 'Failed to retry Repo Wiki page');
    }
  });

  app.delete('/api/repo-wiki/:projectId', async (req, res) => {
    const projectId = requireProjectId(req, res);
    if (!projectId) return;
    try {
      res.json(await repoWikiRuntime.deleteWiki({ projectId }));
    } catch (error) {
      respondWithError(res, error, 'Failed to delete Repo Wiki');
    }
  });

  // Unclaimed /api/repo-wiki/* subpaths: our 404 JSON, never the OpenCode
  // proxy's HTML. This is the regression guard for registration order.
  app.use('/api/repo-wiki', (req, res) => {
    res.status(404).json({ error: 'Not found', reason: 'not-found' });
  });
}
