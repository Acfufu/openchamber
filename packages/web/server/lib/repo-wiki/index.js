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
 * - A page call is retried in place when the request consents to a retry
 *   budget (`retries`, 0-3, default 0): same prompt, same model, no error
 *   classification, fixed pause between attempts. Stop wins during calls and
 *   during the pause. The consent math is (retries + 1) page calls per page.
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

import fsp from 'fs/promises';

import simpleGit from 'simple-git';

import { getRepositoryRoot } from '../git/service.js';
import { normalizeLanguage } from '../walkthrough/languages.js';
import { buildCatalogDigest, buildPageContext } from './digest.js';
import { buildCatalogPrompt, buildPagePrompt, PROMPT_VERSION, RESPONSE_FORMAT_INSTRUCTION } from './prompt.js';
import {
  catalogResponseSchema,
  normalizeCatalog,
  normalizePage,
  pageResponseSchema,
  parseModelJson,
} from './schema.js';
import { createRepoWikiStore } from './store.js';

const CALL_TIMEOUT_MS = 180_000;

const MAX_PAGE_RETRIES = 3;
const RETRY_DELAY_MS = 2_000;

const fail = (message, statusCode, extra = undefined) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (extra) Object.assign(error, extra);
  return error;
};

/**
 * Consented retry budget for page calls: integer 0..3, default 0. Every
 * request that can trigger page calls carries its own budget — the consent
 * was given for exactly that press.
 */
const normalizeRetries = (value) => {
  if (value == null) return 0;
  if (value.constructor !== Number || !Number.isInteger(value) || value < 0 || value > MAX_PAGE_RETRIES) {
    throw fail(`retries must be an integer between 0 and ${MAX_PAGE_RETRIES}`, 400, { code: 'invalid-retries' });
  }
  return value;
};

/** Fixed pause between page-call attempts; an abort during the pause wins. */
const waitBeforeRetry = (signal) => new Promise((resolve) => {
  if (signal?.aborted) {
    resolve(true);
    return;
  }
  const onAbort = () => {
    clearTimeout(timer);
    resolve(true);
  };
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve(false);
  }, RETRY_DELAY_MS);
  signal?.addEventListener('abort', onAbort, { once: true });
});

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

  /** Display metadata only: staleness is compared commit-to-commit. */
  const getCurrentBranch = async (repoRoot) => {
    try {
      const branch = await simpleGit({ baseDir: repoRoot }).raw(['symbolic-ref', '--short', 'HEAD']);
      const name = branch.trim();
      return name || null;
    } catch {
      // A detached HEAD has no branch to name; the wiki omits it.
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
      // Provider HTTP errors carry `status` (small-model call.js); the
      // walkthrough's refusal check reads the same property.
      const statusCode = Number(error?.status ?? error?.statusCode);
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
  const executeRetry = async ({ projectId, repoRoot, manifest, page, model, retries, cancelFlag }) => {
    const persist = async () => store.writeManifest(projectId, manifest);
    const signal = cancelFlag.controller.signal;
    const pageAttempts = retries + 1;
    let attempts = 0;
    try {
      for (let attempt = 1; attempt <= pageAttempts; attempt += 1) {
        attempts += 1;
        try {
          await generatePage({
            projectId,
            repoRoot,
            page,
            model,
            catalogPages: manifest.catalog.pages,
            language: manifest.language,
            diagrams: manifest.diagrams,
            signal,
          });
          page.status = 'done';
          page.error = undefined;
          page.errorCode = undefined;
          manifest.run = {
            status: 'done',
            stage: 'done',
            startedAt: manifest.run.startedAt,
            finishedAt: now(),
            retriedPage: page.id,
            attempts,
          };
          await persist();
          return;
        } catch (error) {
          page.error = error?.message || 'page generation failed';
          page.errorCode = error?.code;
          if (attempt === pageAttempts) break;
          if (await waitBeforeRetry(signal)) break;
        }
      }
      page.status = 'failed';
      manifest.run = {
        status: 'failed',
        stage: 'failed',
        startedAt: manifest.run.startedAt,
        finishedAt: now(),
        retriedPage: page.id,
        attempts,
        error: page.error,
        errorCode: page.errorCode,
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
  const executeRun = async ({ projectId, repoRoot, manifest, model, language, diagrams, retries, cancelFlag }) => {
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

        const pageAttempts = retries + 1;
        for (let attempt = 1; attempt <= pageAttempts; attempt += 1) {
          manifest.run = { ...manifest.run, attempts: (manifest.run.attempts ?? 0) + 1 };
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
            page.error = undefined;
            page.errorCode = undefined;
            manifest.run = { ...manifest.run, generatedPages: manifest.run.generatedPages + 1 };
            break;
          } catch (pageError) {
            if (cancelFlag.cancelRequested || signal.aborted) {
              // A stop is not a failure: the page goes back to pending. Stop
              // wins during the call and during the pause before a retry.
              page.status = 'pending';
              break;
            }
            page.error = pageError?.message || 'page generation failed';
            page.errorCode = pageError?.code;
            if (attempt === pageAttempts) {
              // Terminal failure keeps the last attempt's stable code.
              page.status = 'failed';
              break;
            }
            if (await waitBeforeRetry(signal)) {
              page.status = 'pending';
              break;
            }
          }
        }
        page.updatedAt = now();
        await persist();
        if (cancelFlag.cancelRequested || signal.aborted) break;
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
      // An abort surfaces here when the stop lands during the digest/catalog
      // calls; a stop is not a failure, same as the page-loop path.
      const stopped = cancelFlag.cancelRequested || signal.aborted;
      manifest.run = {
        ...manifest.run,
        status: stopped ? 'stopped' : 'failed',
        stage: stopped ? 'stopped' : 'failed',
        finishedAt: now(),
        error: stopped ? undefined : (error?.message || 'generation failed'),
        errorCode: stopped ? undefined : error?.code,
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

  /**
   * Placement scan over the store root: every stored manifest that still
   * parses, keyed by its directory name. Unreadable entries are skipped so
   * one broken project cannot blind the whole listing.
   */
  const readStoredManifests = async () => {
    let names;
    try {
      names = await fsp.readdir(store.rootDir);
    } catch {
      return [];
    }
    const found = [];
    for (const name of names) {
      try {
        const manifest = await store.readManifest(name);
        if (manifest) found.push({ projectId: name, manifest });
      } catch {
        continue;
      }
    }
    return found;
  };

  /**
   * Pages stuck in `writing` died mid-call with the previous server process:
   * recovery records them failed with a stable code so they become
   * individually retryable. This lives here — page-status semantics belong to
   * the run state machine — not in the store, which owns placement and
   * integrity only.
   */
  const recoverInterruptedPages = async () => {
    let recovered = 0;
    for (const { projectId, manifest } of await readStoredManifests()) {
      const stuck = manifest.catalog?.pages?.filter((page) => page?.status === 'writing') ?? [];
      if (stuck.length === 0) continue;
      for (const page of stuck) {
        page.status = 'failed';
        page.error = 'interrupted by server restart';
        page.errorCode = 'interrupted';
        page.updatedAt = now();
      }
      try {
        await store.writeManifest(projectId, manifest);
        recovered += stuck.length;
      } catch {
        // Leave it; a manifest that cannot be rewritten reads as-is until the
        // next successful write.
      }
    }
    return recovered;
  };

  /**
   * Read-only cross-project listing for the panel's switcher. Display fields
   * only: no git is consulted, so staleness is unknowable here by design —
   * manifests record no source directory to compare against.
   */
  const listWikis = async () => {
    const wikis = [];
    for (const { projectId, manifest } of await readStoredManifests()) {
      const pages = Array.isArray(manifest.catalog?.pages) ? manifest.catalog.pages : [];
      wikis.push({
        projectId,
        branch: manifest.branch ?? null,
        commit: manifest.commit ?? null,
        language: manifest.language ?? null,
        updatedAt: manifest.run?.finishedAt ?? null,
        pagesDone: pages.filter((page) => page?.status === 'done').length,
        pagesFailed: pages.filter((page) => page?.status === 'failed').length,
        run: manifest.run && manifest.run.status
          ? { status: manifest.run.status, stage: manifest.run.stage ?? null }
          : null,
      });
    }
    return { wikis };
  };

  return {
    store,
    /** Called once during route registration: a restart killed any live run. */
    recover: async () => {
      await store.recoverInterruptedRuns();
      return recoverInterruptedPages();
    },

    listWikis,

    async getStatus({ projectId, directory }) {
      const manifest = await store.readManifest(projectId);
      const runActive = activeRuns.has(projectId);
      if (!manifest) {
        return {
          wiki: null,
          ...(directory ? { stale: false } : {}),
          runActive,
        };
      }

      let stale = false;
      if (directory && manifest.commit) {
        const repoRoot = await getRepositoryRoot(directory);
        const currentCommit = await getCurrentCommit(repoRoot);
        stale = Boolean(currentCommit) && currentCommit !== manifest.commit;
      }

      return {
        wiki: {
          commit: manifest.commit,
          branch: manifest.branch ?? null,
          language: manifest.language,
          diagrams: manifest.diagrams,
          model: manifest.model,
          generatedAt: manifest.run?.startedAt,
          run: manifest.run,
          catalog: manifest.catalog,
        },
        // A directory-less read (the cross-project switcher) cannot compare
        // commits, so staleness is omitted rather than guessed.
        ...(directory ? { stale } : {}),
        runActive,
      };
    },

    async readPage({ projectId, pageId }) {
      return store.readPage(projectId, pageId);
    },

    async startGeneration({ projectId, directory, options = {} }) {
      assertNotRunning(projectId);

      // Reserve the slot before the first await: the check and the
      // reservation are one synchronous step, so an overlapping request gets
      // the 409 instead of racing past it and leaving a run whose cancel
      // flag was overwritten — which stop could never abort.
      const cancelFlag = { cancelRequested: false, controller: new AbortController() };
      activeRuns.set(projectId, cancelFlag);

      try {
        const repoRoot = await getRepositoryRoot(directory);
        const retries = normalizeRetries(options.retries);
        const existing = await store.readManifest(projectId);
        const language = normalizeLanguage(options.language);
        const diagrams = options.diagrams != null ? options.diagrams === true : true;
        const modelRef = resolveModelRef({ requestedModel: options.model, manifest: existing });
        const model = await describeResolvedModel({ directory, modelRef });
        const commit = await getCurrentCommit(repoRoot);
        const branch = await getCurrentBranch(repoRoot);

        const manifest = {
          projectId,
          promptVersion: PROMPT_VERSION,
          commit,
          branch,
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
        void executeRun({ projectId, repoRoot, manifest, model, language, diagrams, retries, cancelFlag });
        return { started: true, model: manifest.model };
      } catch (error) {
        activeRuns.delete(projectId);
        throw error;
      }
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
    async requestRetry({ projectId, directory, pageId, retries }) {
      assertNotRunning(projectId);

      // Same reserve-before-await order as startGeneration: two overlapping
      // retries must not both pass the check.
      const cancelFlag = { cancelRequested: false, controller: new AbortController() };
      activeRuns.set(projectId, cancelFlag);

      try {
        const retryBudget = normalizeRetries(retries);
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

        manifest.run = {
          status: 'running',
          stage: 'pages',
          startedAt: now(),
          retriedPage: pageId,
        };
        page.status = 'writing';
        await store.writeManifest(projectId, manifest);

        void executeRetry({ projectId, repoRoot, manifest, page, model, retries: retryBudget, cancelFlag });
        return { retried: true, pageId };
      } catch (error) {
        activeRuns.delete(projectId);
        throw error;
      }
    },

    async deleteWiki({ projectId }) {
      assertNotRunning(projectId);
      await store.deleteWiki(projectId);
      return { deleted: true };
    },
  };
};
