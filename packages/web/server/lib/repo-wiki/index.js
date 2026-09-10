/**
 * Repo Wiki generation orchestration.
 *
 * One generation run per project, driven as a background job the panel polls:
 *
 *   digesting → catalog → pages → done | stopped | failed
 *
 * - The catalog becomes readable the moment it lands (pages still `pending`),
 *   so the user watches the wiki grow instead of a spinner.
 * - A page that fails is recorded and the run continues; only a run where
 *   every page failed is `failed`. Stop keeps every finished page.
 * - The model call is injected (`modelCall`), as is model description
 *   (`describeModel`) — the tests drive whole runs against fixture repos
 *   without any provider, and the real wiring stays a thin adapter.
 *
 * Model resolution: the request's explicit choice → the model recorded in the
 * manifest (regenerating keeps what produced the current wiki) → the user's
 * OpenChamber default model. The small-model chain is deliberately not a
 * fallback: a wiki wants the biggest context the user has, not the cheapest
 * model. No choice anywhere fails with `no-model`.
 */

import path from 'path';

import simpleGit from 'simple-git';

import { getRepositoryRoot } from '../git/service.js';
import { normalizeLanguage } from '../walkthrough/languages.js';
import { buildCatalogDigest, buildPageContext } from './digest.js';
import { buildCatalogPrompt, buildPagePrompt, RESPONSE_FORMAT_INSTRUCTION } from './prompt.js';
import {
  catalogResponseSchema,
  normalizeCatalog,
  normalizePage,
  pageResponseSchema,
  parseModelJson,
} from './schema.js';
import { createRepoWikiStore } from './store.js';

const CALL_TIMEOUT_MS = 180_000;

const fail = (message, statusCode, extra = undefined) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (extra) Object.assign(error, extra);
  return error;
};

/** `provider/model` — the one model reference format every picker speaks. */
const MODEL_REF_PATTERN = /^[^\s/]+\/[^\s/]+$/;

const parseModelRef = (value) => {
  if (value == null || value.constructor !== String) return null;
  const trimmed = value.trim();
  if (!MODEL_REF_PATTERN.test(trimmed)) return null;
  const [providerID, modelID] = trimmed.split('/');
  return { providerID, modelID };
};

/** One attempt against the real model stack; tests replace this wholesale. */
const defaultModelCall = async ({ directory, model, system, prompt, responseSchema, timeoutMs, signal }) => {
  const { generateSmallModelText } = await import('../small-model/index.js');
  return generateSmallModelText({
    prompt,
    system,
    model: `${model.providerID}/${model.modelID}`,
    directory,
    responseSchema,
    timeoutMs,
    signal,
    maxOutputTokens: model.outputTokens ?? undefined,
    onOverflow: 'error',
  });
};

/** One model description; tests replace this wholesale. */
const defaultDescribeModel = async ({ directory, model }) => {
  const { describeSmallModel } = await import('../small-model/index.js');
  return describeSmallModel({
    directory,
    overrideModel: `${model.providerID}/${model.modelID}`,
    // Pages are the long outputs in this feature; reserve half the model's
    // output room, bounded, so the input budget and the request agree.
    outputReserveTokens: ({ outputTokenLimit }) => {
      if (!(Number(outputTokenLimit) > 0)) return 8_192;
      return Math.min(16_000, Math.max(4_000, Math.floor(Number(outputTokenLimit) / 2)));
    },
  });
};

export const createRepoWikiRuntime = ({
  dataDir,
  readSettings = () => ({}),
  modelCall = defaultModelCall,
  describeModel = defaultDescribeModel,
}) => {
  const store = createRepoWikiStore({ dataDir });

  /** projectId → run controller; presence IS the one-run-per-project lock. */
  const activeRuns = new Map();

  // Process-lifetime, on purpose: a provider that refused structured output
  // once will refuse again, and the prompt-side fallback is a foregone
  // conclusion worth skipping (same memo the walkthrough keeps).
  const schemaRefusedBy = new Set();

  const modelKey = (model) => `${model.providerID}/${model.modelID}`;

  const getCurrentCommit = async (repoRoot) => {
    try {
      const head = await simpleGit({ baseDir: repoRoot }).raw(['rev-parse', 'HEAD']);
      const commit = head.trim();
      return commit || null;
    } catch {
      // A repository without commits has no HEAD; the wiki simply never
      // reports stale against nothing.
      return null;
    }
  };

  const asObject = (value) => {
    if (value == null || Array.isArray(value) || value.constructor !== Object) return {};
    return value;
  };

  /**
   * Request-explicit choice → the model recorded in the manifest → the user's
   * default model. Anything unparseable is treated as absent.
   */
  const resolveModelRef = ({ requestedModel, manifest }) => {
    const explicit = parseModelRef(requestedModel);
    if (explicit) return explicit;

    const recorded = asObject(manifest?.model);
    if (recorded.providerID && recorded.modelID) {
      return { providerID: recorded.providerID, modelID: recorded.modelID };
    }

    const settings = asObject(readSettings());
    const fallback = parseModelRef(settings.defaultModel);
    if (fallback) return fallback;

    throw fail('No model available — pick a model for this wiki', 404, { code: 'no-model' });
  };

  const describeResolvedModel = async ({ directory, modelRef }) => {
    const described = await describeModel({ directory, model: modelRef });
    if (!described) {
      throw fail(`Model ${modelRef.providerID}/${modelRef.modelID} is not available`, 404, { code: 'no-model' });
    }
    if (!described.hasLogin) {
      throw fail(
        `No OpenCode login found for provider "${described.providerID}" — sign in or choose a different model`,
        401,
        { code: 'no-provider-login', model: described },
      );
    }
    return described;
  };

  /**
   * One schema-shaped call with the walkthrough's one-shot fallback: a
   * provider that rejects schemas (4xx) gets the JSON shape in the prompt
   * instead, once, and the refusal is remembered for the process lifetime.
   * Known request failures (context, login, model) propagate untouched.
   */
  const callWithSchemaFallback = async ({ directory, model, system, prompt, responseSchema, signal }) => {
    const attempt = (useSchema) => modelCall({
      directory,
      model,
      system: useSchema ? system : `${system}\n${RESPONSE_FORMAT_INSTRUCTION}`,
      prompt,
      responseSchema: useSchema ? responseSchema : undefined,
      timeoutMs: CALL_TIMEOUT_MS,
      signal,
    });

    if (schemaRefusedBy.has(modelKey(model))) {
      return attempt(false);
    }

    try {
      return await attempt(true);
    } catch (error) {
      const statusCode = Number(error?.statusCode);
      const isRequestFailure = ['context-too-small', 'output-exhausted', 'no-provider-login', 'no-model']
        .includes(error?.code);
      if (isRequestFailure) throw error;
      if (!(error?.code === 'structured-output-unsupported' || (statusCode >= 400 && statusCode < 500))) throw error;

      schemaRefusedBy.add(modelKey(model));
      return attempt(false);
    }
  };

  const now = () => new Date().toISOString();

  /** One page: build context, prompt, call the model, persist the markdown. */
  const generatePage = async ({ projectId, repoRoot, page, model, catalogPages, language, diagrams, signal }) => {
    const context = await buildPageContext({
      repoRoot,
      files: page.files,
      budgetChars: model.inputCharBudget,
    });
    const pageCall = buildPagePrompt({
      repoName: path.basename(repoRoot),
      page,
      catalogOutline: catalogPages.map((entry) => `- ${entry.title} (${entry.id})`).join('\n'),
      pageContext: context.context,
      language,
      diagrams,
    });
    const pageRaw = await callWithSchemaFallback({
      directory: repoRoot,
      model,
      system: pageCall.system,
      prompt: pageCall.prompt,
      responseSchema: pageResponseSchema,
      signal,
    });
    const { markdown } = normalizePage(parseModelJson(pageRaw.text));
    await store.writePage(projectId, page.id, markdown);
  };

  /** One failed-page retry as a background job; results land in the manifest. */
  const executeRetry = async ({ projectId, repoRoot, manifest, page, model, cancelFlag }) => {
    const persist = async () => store.writeManifest(projectId, manifest);
    try {
      await generatePage({
        projectId,
        repoRoot,
        page,
        model,
        catalogPages: manifest.catalog.pages,
        language: manifest.language,
        diagrams: manifest.diagrams,
        signal: cancelFlag.controller.signal,
      });
      page.status = 'done';
      page.error = undefined;
      manifest.run = {
        status: 'done',
        stage: 'done',
        startedAt: manifest.run.startedAt,
        finishedAt: now(),
        retriedPage: page.id,
      };
      await persist();
    } catch (error) {
      page.status = 'failed';
      page.error = error?.message || 'page generation failed';
      manifest.run = {
        status: 'failed',
        stage: 'failed',
        startedAt: manifest.run.startedAt,
        finishedAt: now(),
        retriedPage: page.id,
        error: page.error,
        errorCode: error?.code,
      };
      await persist();
    } finally {
      activeRuns.delete(projectId);
    }
  };

  /**
   * The run loop. `manifest` is the progressively-written record; every
   * transition persists, so a reader (the panel poll) always sees the truth.
   */
  const executeRun = async ({ projectId, repoRoot, manifest, model, language, diagrams, cancelFlag }) => {
    const persist = async () => store.writeManifest(projectId, manifest);
    const setStage = async (stage) => {
      manifest.run = { ...manifest.run, stage };
      await persist();
    };

    const signal = cancelFlag.controller.signal;
    const catalogOutline = () => manifest.catalog.pages
      .map((page) => `- ${page.title} (${page.id})`)
      .join('\n');

    try {
      await setStage('digesting');
      const { digest } = await buildCatalogDigest({ repoRoot, budgetChars: model.inputCharBudget });

      await setStage('catalog');
      const catalogCall = buildCatalogPrompt({
        repoName: path.basename(repoRoot),
        digest,
        language,
        diagrams,
      });
      const catalogRaw = await callWithSchemaFallback({
        directory: repoRoot,
        model,
        system: catalogCall.system,
        prompt: catalogCall.prompt,
        responseSchema: catalogResponseSchema,
        signal,
      });
      const { pages } = normalizeCatalog(parseModelJson(catalogRaw.text));

      // The catalog lands here: from now on the panel can show the structure
      // while the pages are still pending.
      manifest.catalog = {
        pages: pages.map((page) => ({ ...page, status: 'pending', updatedAt: now() })),
      };
      manifest.run = { ...manifest.run, stage: 'pages', generatedPages: 0 };
      await persist();

      for (const page of manifest.catalog.pages) {
        if (cancelFlag.cancelRequested) break;

        page.status = 'writing';
        page.updatedAt = now();
        await persist();

        try {
          await generatePage({
            projectId,
            repoRoot,
            page,
            model,
            catalogPages: manifest.catalog.pages,
            language,
            diagrams,
            signal,
          });
          page.status = 'done';
          manifest.run = { ...manifest.run, generatedPages: manifest.run.generatedPages + 1 };
        } catch (pageError) {
          if (cancelFlag.cancelRequested || signal.aborted) {
            // A stop is not a failure: the page goes back to pending.
            page.status = 'pending';
            break;
          }
          page.status = 'failed';
          page.error = pageError?.message || 'page generation failed';
        }
        page.updatedAt = now();
        await persist();
      }

      const pagesDone = manifest.catalog.pages.filter((page) => page.status === 'done').length;
      const pagesFailed = manifest.catalog.pages.filter((page) => page.status === 'failed').length;

      let status = 'done';
      if (cancelFlag.cancelRequested) status = 'stopped';
      else if (pagesDone === 0 && pagesFailed > 0) status = 'failed';
      else if (pagesFailed > 0) status = 'done';

      const finalRun = {
        ...manifest.run,
        status,
        stage: status,
        finishedAt: now(),
      };
      if (pagesFailed > 0) finalRun.failedPages = pagesFailed;
      manifest.run = finalRun;
      await persist();
    } catch (error) {
      manifest.run = {
        ...manifest.run,
        status: 'failed',
        stage: 'failed',
        finishedAt: now(),
        error: error?.message || 'generation failed',
        errorCode: error?.code,
      };
      await persist();
    } finally {
      activeRuns.delete(projectId);
    }
  };

  const assertNotRunning = (projectId) => {
    if (activeRuns.has(projectId)) {
      throw fail('A Repo Wiki generation is already running for this project', 409, { code: 'run-in-progress' });
    }
  };

  return {
    store,
    /** Called once during route registration: a restart killed any live run. */
    recover: () => store.recoverInterruptedRuns(),

    async getStatus({ projectId, directory }) {
      const manifest = await store.readManifest(projectId);
      const runActive = activeRuns.has(projectId);
      if (!manifest) {
        return { wiki: null, stale: false, runActive };
      }

      let stale = false;
      if (manifest.commit) {
        const repoRoot = await getRepositoryRoot(directory);
        const currentCommit = await getCurrentCommit(repoRoot);
        stale = Boolean(currentCommit) && currentCommit !== manifest.commit;
      }

      return {
        wiki: {
          commit: manifest.commit,
          language: manifest.language,
          diagrams: manifest.diagrams,
          model: manifest.model,
          generatedAt: manifest.run?.startedAt,
          run: manifest.run,
          catalog: manifest.catalog,
        },
        stale,
        runActive,
      };
    },

    async readPage({ projectId, pageId }) {
      return store.readPage(projectId, pageId);
    },

    async startGeneration({ projectId, directory, options = {} }) {
      assertNotRunning(projectId);

      const repoRoot = await getRepositoryRoot(directory);
      const existing = await store.readManifest(projectId);
      const language = normalizeLanguage(options.language);
      const diagrams = options.diagrams != null ? options.diagrams === true : true;
      const modelRef = resolveModelRef({ requestedModel: options.model, manifest: existing });
      const model = await describeResolvedModel({ directory, modelRef });
      const commit = await getCurrentCommit(repoRoot);

      const cancelFlag = { cancelRequested: false, controller: new AbortController() };
      activeRuns.set(projectId, cancelFlag);

      const manifest = {
        projectId,
        commit,
        language,
        diagrams,
        model: { providerID: model.providerID, modelID: model.modelID },
        catalog: { pages: [] },
        run: {
          status: 'running',
          stage: 'digesting',
          startedAt: now(),
        },
      };
      await store.writeManifest(projectId, manifest);

      // Fire-and-forget: the route answers immediately and the panel polls.
      void executeRun({ projectId, repoRoot, manifest, model, language, diagrams, cancelFlag });
      return { started: true, model: manifest.model };
    },

    async stopGeneration({ projectId }) {
      const cancelFlag = activeRuns.get(projectId);
      if (!cancelFlag) return { stopped: false };
      cancelFlag.cancelRequested = true;
      cancelFlag.controller.abort();
      return { stopped: true };
    },

    /**
     * Regenerate one page of an existing wiki, as a background job the panel
     * polls (a page call can run for minutes). Only failed pages are
     * retryable — a done page is part of a coherent whole and changes only
     * through a full regeneration. Validation happens before the response so
     * the caller sees real errors; the result lands in the manifest.
     */
    async requestRetry({ projectId, directory, pageId }) {
      assertNotRunning(projectId);

      const manifest = await store.readManifest(projectId);
      if (!manifest) {
        throw fail('No Repo Wiki exists for this project', 404, { code: 'no-wiki' });
      }
      const page = manifest.catalog?.pages?.find((entry) => entry.id === pageId);
      if (!page) {
        throw fail('Unknown page', 404, { code: 'unknown-page' });
      }
      if (page.status !== 'failed') {
        throw fail('Only a failed page can be retried — regenerate the wiki instead', 409, { code: 'page-not-failed' });
      }

      const repoRoot = await getRepositoryRoot(directory);
      const modelRef = resolveModelRef({ requestedModel: null, manifest });
      const model = await describeResolvedModel({ directory, modelRef });

      const cancelFlag = { cancelRequested: false, controller: new AbortController() };
      activeRuns.set(projectId, cancelFlag);

      manifest.run = {
        status: 'running',
        stage: 'pages',
        startedAt: now(),
        retriedPage: pageId,
      };
      page.status = 'writing';
      await store.writeManifest(projectId, manifest);

      void executeRetry({ projectId, repoRoot, manifest, page, model, cancelFlag });
      return { retried: true, pageId };
    },

    async deleteWiki({ projectId }) {
      assertNotRunning(projectId);
      await store.deleteWiki(projectId);
      return { deleted: true };
    },
  };
};
