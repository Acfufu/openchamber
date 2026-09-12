/**
 * Client for the OpenChamber Repo Wiki routes
 * (`packages/web/server/lib/repo-wiki`). The server owns generation and
 * storage; this module only speaks HTTP and parses responses into trusted
 * types, so the shared UI knows nothing about where the wiki lives on disk.
 *
 * Every function throws on failure. An authoritative read must never resolve
 * to an empty value that a caller could mistake for "the project has no wiki".
 */

import { createProjectIdFromPath } from './projectId';
import { runtimeFetch } from './runtime-fetch';

export type RepoWikiPageStatus = 'pending' | 'writing' | 'done' | 'failed';

export type RepoWikiDiagramKind = 'architecture' | 'flow' | 'sequence' | 'state' | 'component';

export interface RepoWikiPageMeta {
  id: string;
  title: string;
  purpose: string;
  files: string[];
  diagram: RepoWikiDiagramKind | null;
  status: RepoWikiPageStatus;
  updatedAt: string | null;
  error: string | null;
  errorCode: string | null;
}

export type RepoWikiRunStatus = 'running' | 'done' | 'stopped' | 'failed';

export interface RepoWikiRunState {
  status: RepoWikiRunStatus;
  stage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  errorCode: string | null;
  generatedPages: number | null;
  failedPages: number | null;
  retriedPage: string | null;
  attempts: number | null;
}

export interface RepoWikiModelRef {
  providerID: string;
  modelID: string;
}

export interface RepoWikiStatus {
  commit: string | null;
  language: string;
  diagrams: boolean;
  model: RepoWikiModelRef | null;
  generatedAt: string | null;
  run: RepoWikiRunState | null;
  catalog: { pages: RepoWikiPageMeta[] } | null;
}

export interface RepoWikiStatusResult {
  wiki: RepoWikiStatus | null;
  stale: boolean;
  runActive: boolean;
}

export interface RepoWikiGenerateOptions {
  language?: string;
  diagrams?: boolean;
  model?: string;
  /** Consented retry budget per page call (integer 0-3, default 0). */
  retries?: number;
}

export class RepoWikiRequestError extends Error {
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

/** The storage id is derived from the project path, mirroring the server. */
export const resolveRepoWikiProjectId = (projectPath: string): string => createProjectIdFromPath(projectPath);

const asString = (value: any, fallback: string | null = null): string | null => {
  if (value == null || value.constructor !== String) return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
};

const DIAGRAM_KINDS: readonly RepoWikiDiagramKind[] = ['architecture', 'flow', 'sequence', 'state', 'component'];
const PAGE_STATUSES: readonly RepoWikiPageStatus[] = ['pending', 'writing', 'done', 'failed'];
const RUN_STATUSES: readonly RepoWikiRunStatus[] = ['running', 'done', 'stopped', 'failed'];

const parsePageMeta = (value: any): RepoWikiPageMeta | null => {
  if (value == null || value.constructor !== Object) return null;
  const id = asString(value.id);
  if (!id) return null;
  return {
    id,
    title: asString(value.title) ?? id,
    purpose: asString(value.purpose) ?? '',
    files: Array.isArray(value.files) ? value.files.filter((entry: any) => asString(entry)) : [],
    diagram: DIAGRAM_KINDS.includes(value.diagram) ? value.diagram : null,
    status: PAGE_STATUSES.includes(value.status) ? value.status : 'pending',
    updatedAt: asString(value.updatedAt),
    error: asString(value.error),
    errorCode: asString(value.errorCode),
  };
};

const parseRunState = (value: any): RepoWikiRunState | null => {
  if (value == null || value.constructor !== Object) return null;
  return {
    status: RUN_STATUSES.includes(value.status) ? value.status : 'done',
    stage: asString(value.stage),
    startedAt: asString(value.startedAt),
    finishedAt: asString(value.finishedAt),
    error: asString(value.error),
    errorCode: asString(value.errorCode),
    generatedPages: value.generatedPages != null && value.generatedPages.constructor === Number && Number.isFinite(value.generatedPages) ? value.generatedPages : null,
    failedPages: value.failedPages != null && value.failedPages.constructor === Number && Number.isFinite(value.failedPages) ? value.failedPages : null,
    retriedPage: asString(value.retriedPage),
    attempts: value.attempts != null && value.attempts.constructor === Number && Number.isFinite(value.attempts) ? value.attempts : null,
  };
};

const parseStatus = (payload: any): RepoWikiStatusResult => {
  if (payload == null || payload.constructor !== Object) {
    throw new RepoWikiRequestError('Malformed Repo Wiki status response', 'malformed-response', null, null);
  }
  const wikiValue = payload.wiki;
  let wiki: RepoWikiStatus | null = null;
  if (wikiValue != null && wikiValue.constructor === Object) {
    const modelValue = wikiValue.model;
    const catalogValue = wikiValue.catalog;
    wiki = {
      commit: asString(wikiValue.commit),
      language: asString(wikiValue.language) ?? 'en',
      diagrams: wikiValue.diagrams === true,
      model: modelValue != null && modelValue.constructor === Object
        ? { providerID: asString(modelValue.providerID) ?? '', modelID: asString(modelValue.modelID) ?? '' }
        : null,
      generatedAt: asString(wikiValue.generatedAt),
      run: parseRunState(wikiValue.run),
      catalog: catalogValue != null && catalogValue.constructor === Object && Array.isArray(catalogValue.pages)
        ? {
            pages: catalogValue.pages
              .map(parsePageMeta)
              .filter((page: RepoWikiPageMeta | null): page is RepoWikiPageMeta => page !== null),
          }
        : null,
    };
  }
  return {
    wiki,
    stale: payload.stale === true,
    runActive: payload.runActive === true,
  };
};

const basePath = (projectId: string): string => `/api/repo-wiki/${encodeURIComponent(projectId)}`;

const readError = async (response: Response, fallback: string): Promise<RepoWikiRequestError> => {
  let message = '';
  let code: string | null = null;
  let requiredChars: number | null = null;
  let availableChars: number | null = null;
  try {
    const payload = await response.json();
    if (payload != null && payload.constructor === Object) {
      message = asString(payload.error) ?? '';
      code = asString(payload.code);
      requiredChars = payload.requiredChars != null && payload.requiredChars.constructor === Number ? payload.requiredChars : null;
      availableChars = payload.availableChars != null && payload.availableChars.constructor === Number ? payload.availableChars : null;
    }
  } catch {
    // A body that is not JSON leaves the generic message in place.
  }
  return new RepoWikiRequestError(message || `${fallback} (${response.status})`, code, requiredChars, availableChars);
};

export const fetchRepoWikiStatus = async (
  projectPath: string,
  options: { signal?: AbortSignal } = {},
): Promise<RepoWikiStatusResult> => {
  const response = await runtimeFetch(`${basePath(resolveRepoWikiProjectId(projectPath))}?directory=${encodeURIComponent(projectPath)}`, {
    cache: 'no-store',
    signal: options.signal,
  });
  if (!response.ok) {
    throw await readError(response, 'Failed to read Repo Wiki status');
  }
  return parseStatus(await response.json());
};

export const fetchRepoWikiPage = async (
  projectPath: string,
  pageId: string,
  options: { signal?: AbortSignal } = {},
): Promise<string> => {
  const response = await runtimeFetch(
    `${basePath(resolveRepoWikiProjectId(projectPath))}/pages/${encodeURIComponent(pageId)}`,
    { cache: 'no-store', signal: options.signal },
  );
  if (!response.ok) {
    throw await readError(response, 'Failed to read Repo Wiki page');
  }
  const payload = await response.json();
  const markdown = payload != null && payload.constructor === Object ? asString(payload.markdown) : null;
  if (!markdown) {
    throw new RepoWikiRequestError('Malformed Repo Wiki page response', 'malformed-response', null, null);
  }
  return markdown;
};

interface RepoWikiGenerateBody {
  directory: string;
  language?: string;
  model?: string;
  diagrams?: boolean;
  retries?: number;
}

export const startRepoWikiGeneration = async (
  projectPath: string,
  options: RepoWikiGenerateOptions = {},
): Promise<{ started: boolean }> => {
  const body: RepoWikiGenerateBody = { directory: projectPath };
  if (options.language) body.language = options.language;
  if (options.model) body.model = options.model;
  if (options.diagrams != null) body.diagrams = options.diagrams === true;
  if (options.retries != null) body.retries = options.retries;

  const response = await runtimeFetch(`${basePath(resolveRepoWikiProjectId(projectPath))}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw await readError(response, 'Failed to start Repo Wiki generation');
  }
  const payload = await response.json();
  return { started: payload != null && payload.constructor === Object ? payload.started === true : false };
};

export const stopRepoWikiGeneration = async (projectPath: string): Promise<{ stopped: boolean }> => {
  const response = await runtimeFetch(`${basePath(resolveRepoWikiProjectId(projectPath))}/stop`, { method: 'POST' });
  if (!response.ok) {
    throw await readError(response, 'Failed to stop Repo Wiki generation');
  }
  const payload = await response.json();
  return { stopped: payload != null && payload.constructor === Object ? payload.stopped === true : false };
};

interface RepoWikiRetryBody {
  directory: string;
  retries?: number;
}

export const retryRepoWikiPage = async (
  projectPath: string,
  pageId: string,
  options: { retries?: number } = {},
): Promise<{ retried: boolean }> => {
  const body: RepoWikiRetryBody = { directory: projectPath };
  if (options.retries != null) body.retries = options.retries;
  const response = await runtimeFetch(
    `${basePath(resolveRepoWikiProjectId(projectPath))}/pages/${encodeURIComponent(pageId)}/retry`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    throw await readError(response, 'Failed to retry Repo Wiki page');
  }
  const payload = await response.json();
  return { retried: payload != null && payload.constructor === Object ? payload.retried === true : false };
};

export const deleteRepoWiki = async (projectPath: string): Promise<{ deleted: boolean }> => {
  const response = await runtimeFetch(`${basePath(resolveRepoWikiProjectId(projectPath))}`, { method: 'DELETE' });
  if (!response.ok) {
    throw await readError(response, 'Failed to delete Repo Wiki');
  }
  const payload = await response.json();
  return { deleted: payload != null && payload.constructor === Object ? payload.deleted === true : false };
};
