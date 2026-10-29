/**
 * Client for the OpenChamber Repo Wiki routes
 * (`packages/web/server/lib/repo-wiki`). The server owns generation and
 * storage; this module only speaks HTTP and parses responses into trusted
 * types, so the shared UI knows nothing about where the wiki lives on disk.
 *
 * Every function throws on failure. An authoritative read must never resolve
 * to an empty value that a caller could mistake for "the project has no wiki".
 */

import { z } from 'zod';

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

/** Coarse thought level enum; null (absent) means the model's own default. */
export type RepoWikiThoughtLevel = 'off' | 'low' | 'medium' | 'high';

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
  /** Display metadata only; staleness is compared commit-to-commit. */
  branch: string | null;
  language: string;
  diagrams: boolean;
  /** The generation option's recorded level; null = model default. */
  thoughtLevel: RepoWikiThoughtLevel | null;
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
  /** Coarse thought level; absent sends nothing (model default). */
  thoughtLevel?: RepoWikiThoughtLevel;
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

const RUN_STATUSES: readonly RepoWikiRunStatus[] = ['running', 'done', 'stopped', 'failed'];

/**
 * The status route's wire shape as `response.json()` yields it. The property
 * types stay open on purpose: the zod schemas below re-derive every field, so
 * a malformed field reads as absent instead of poisoning the entry.
 */
interface RepoWikiStatusWire {
  wiki?: RepoWikiStateWire;
  stale?: boolean;
  runActive?: boolean;
}

interface RepoWikiStateWire {
  commit?: unknown;
  branch?: unknown;
  language?: unknown;
  diagrams?: unknown;
  thoughtLevel?: unknown;
  model?: unknown;
  catalog?: unknown;
  generatedAt?: unknown;
  run?: unknown;
}

/** Trimmed text; null when the field is absent, empty, or not a string. */
const trimmedText = z.string().trim().transform((value) => (value.length > 0 ? value : null)).nullable().catch(null);
const finiteOrNull = z.number().finite().nullable().catch(null);

const wikiModelRef = z.object({
  providerID: z.string().catch(''),
  modelID: z.string().catch(''),
}).transform((model) => ({ providerID: model.providerID.trim(), modelID: model.modelID.trim() })).nullable().catch(null);

const wikiPage = z.object({
  id: z.string().trim().min(1),
  title: trimmedText,
  purpose: trimmedText,
  files: z.array(z.string().trim().min(1).nullable().catch(null)).transform((files) => files.filter((file) => file !== null)).catch([]),
  diagram: z.enum(['architecture', 'flow', 'sequence', 'state', 'component']).nullable().catch(null),
  status: z.enum(['pending', 'writing', 'done', 'failed']).catch('pending'),
  updatedAt: trimmedText,
  error: trimmedText,
  errorCode: trimmedText,
}).transform((page) => ({
  ...page,
  title: page.title ?? page.id,
  purpose: page.purpose ?? '',
})).nullable().catch(null);

const wikiRun = z.object({
  status: z.enum(['running', 'done', 'stopped', 'failed']).catch('done'),
  stage: trimmedText,
  startedAt: trimmedText,
  finishedAt: trimmedText,
  error: trimmedText,
  errorCode: trimmedText,
  generatedPages: finiteOrNull,
  failedPages: finiteOrNull,
  retriedPage: trimmedText,
  attempts: finiteOrNull,
}).nullable().catch(null);

const wikiState = z.object({
  commit: trimmedText,
  branch: trimmedText,
  language: trimmedText.transform((language) => language ?? 'en'),
  diagrams: z.unknown().transform((value) => value === true),
  thoughtLevel: z.enum(['off', 'low', 'medium', 'high']).nullable().catch(null),
  model: wikiModelRef,
  generatedAt: trimmedText,
  run: wikiRun,
  catalog: z.object({ pages: z.array(wikiPage).transform((pages) => pages.filter((page) => page !== null)) }).nullable().catch(null),
}).nullable().catch(null);

const wikiStatusResponse = z.object({
  wiki: wikiState,
  stale: z.unknown().transform((value) => value === true),
  runActive: z.unknown().transform((value) => value === true),
});

/** The one boundary where the status route's JSON becomes trusted types. */
const parseStatus = (payload: RepoWikiStatusWire): RepoWikiStatusResult => {
  const parsed = wikiStatusResponse.safeParse(payload);
  if (!parsed.success) {
    throw new RepoWikiRequestError('Malformed Repo Wiki status response', 'malformed-response', null, null);
  }
  return parsed.data;
};

const asString = (value: string | null | undefined, fallback: string | null = null): string | null => {
  if (value == null) return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
};

const basePath = (projectId: string): string => `/api/repo-wiki/${encodeURIComponent(projectId)}`;

export interface RepoWikiListEntry {
  projectId: string;
  branch: string | null;
  commit: string | null;
  language: string | null;
  updatedAt: string | null;
  pagesDone: number;
  pagesFailed: number;
  run: { status: RepoWikiRunStatus; stage: string | null } | null;
}

/**
 * The list-entry shape the server sends. Every field is re-validated by the
 * tolerant readers below — the declared types are the expectation, not the
 * proof; a malformed field reads as absent instead of poisoning the entry.
 */
interface RepoWikiListEntryPayload {
  projectId?: string;
  branch?: string | null;
  commit?: string | null;
  language?: string | null;
  updatedAt?: string | null;
  pagesDone?: number;
  pagesFailed?: number;
  run?: { status?: string; stage?: string | null } | null;
}

const parseListEntry = (entry: RepoWikiListEntryPayload | null | undefined): RepoWikiListEntry | null => {
  const projectId = asString(entry?.projectId);
  if (!entry || !projectId) return null;
  const runStatus = RUN_STATUSES.find((candidate) => candidate === entry.run?.status) ?? null;
  return {
    projectId,
    branch: asString(entry.branch),
    commit: asString(entry.commit),
    language: asString(entry.language),
    updatedAt: asString(entry.updatedAt),
    pagesDone: entry.pagesDone != null && Number.isFinite(entry.pagesDone) ? entry.pagesDone : 0,
    pagesFailed: entry.pagesFailed != null && Number.isFinite(entry.pagesFailed) ? entry.pagesFailed : 0,
    run: runStatus
      ? { status: runStatus, stage: asString(entry.run?.stage) }
      : null,
  };
};

/**
 * Stored wikis across projects for the panel's read-only switcher. The list
 * never carries staleness (the server consults no git here) and a failure
 * throws — an authoritative read must never resolve to a look-alike empty.
 */
export const fetchRepoWikiList = async (options: { signal?: AbortSignal } = {}): Promise<RepoWikiListEntry[]> => {
  const response = await runtimeFetch('/api/repo-wiki', { cache: 'no-store', signal: options.signal });
  if (!response.ok) {
    throw await readError(response, 'Failed to list Repo Wikis');
  }
  const payload = await response.json();
  const wikis = payload != null && payload.constructor === Object && Array.isArray(payload.wikis) ? payload.wikis : null;
  if (wikis == null) {
    throw new RepoWikiRequestError('Malformed Repo Wiki list response', 'malformed-response', null, null);
  }
  return wikis
    .map((entry: RepoWikiListEntryPayload) => parseListEntry(entry))
    .filter((entry: RepoWikiListEntry | null): entry is RepoWikiListEntry => entry !== null);
};

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

export const fetchRepoWikiStatusById = async (
  projectId: string,
  options: { directory?: string; signal?: AbortSignal } = {},
): Promise<RepoWikiStatusResult> => {
  // A directory upgrade opts the read into staleness comparison; without it
  // (cross-project reading) the response omits staleness entirely.
  const query = options.directory ? `?directory=${encodeURIComponent(options.directory)}` : '';
  const response = await runtimeFetch(`${basePath(projectId)}${query}`, {
    cache: 'no-store',
    signal: options.signal,
  });
  if (!response.ok) {
    throw await readError(response, 'Failed to read Repo Wiki status');
  }
  return parseStatus(await response.json());
};

export const fetchRepoWikiStatus = async (
  projectPath: string,
  options: { signal?: AbortSignal } = {},
): Promise<RepoWikiStatusResult> => {
  return fetchRepoWikiStatusById(resolveRepoWikiProjectId(projectPath), { ...options, directory: projectPath });
};

export const fetchRepoWikiPageById = async (
  projectId: string,
  pageId: string,
  options: { signal?: AbortSignal } = {},
): Promise<string> => {
  const response = await runtimeFetch(
    `${basePath(projectId)}/pages/${encodeURIComponent(pageId)}`,
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
  thoughtLevel?: RepoWikiThoughtLevel;
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
  if (options.thoughtLevel != null) body.thoughtLevel = options.thoughtLevel;

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
