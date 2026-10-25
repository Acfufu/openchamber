import fs from 'fs';
import os from 'os';

import { z } from 'zod';

import { assessOpenCodeConfig } from './assessment.js';
import { createOpenCodeTrustStore } from './store.js';

export const OPENCODE_TRUST_REQUIRED = 'opencode_trust_required';
export const OPENCODE_TRUST_ROUTE = '/api/opencode/trust';

const TRUST_REQUIRED_ERROR = 'OpenCode is paused for this folder until you trust the plugins and commands in its configuration';

// A burst of requests for one folder (the UI opening it fires dozens) reads
// its configuration once.
const ASSESSMENT_CACHE_MS = 2000;
const ASSESSMENT_CACHE_LIMIT = 200;

// Reads that never start a location in OpenCode, so they run for a folder
// nobody has trusted: a paused folder still lists and shows its sessions.
// Everything else that names a folder is checked, including routes added
// later, which start out checked.
const GLOBAL_READS = [
  /^\/api\/session$/,
  /^\/api\/session\/active$/,
  /^\/api\/experimental\/session\/stats$/,
  /^\/api\/session\/[^/]+$/,
  /^\/api\/session\/[^/]+\/message(?:\/[^/]+)?$/,
  /^\/api\/(?:global\/)?event$/,
  /^\/api\/credential(?:\/|$)/,
];
// Mutations that never start a location: deleting a session, moving it
// (OpenChamber moves sessions out of folders that are gone), marking it
// viewed, and unloading a location.
const GLOBAL_MUTATIONS = [
  { method: 'DELETE', pattern: /^\/api\/session\/[^/]+$/ },
  { method: 'POST', pattern: /^\/api\/session\/[^/]+\/(?:move|view)$/ },
  { method: 'DELETE', pattern: /^\/api\/debug\/location$/ },
];

const SESSION_SCOPED = /^\/api\/(?:experimental\/)?session\/([^/]+)\/.+$/;

const trustQuerySchema = z.object({ directory: z.string().trim().min(1) });
const trustAnswerSchema = z.object({ directory: z.string().trim().min(1), fingerprint: z.string().nullable() });
const PERCENT_ESCAPE = /%[0-9a-fA-F]{2}/;

const isGlobalRoute = (method, pathname) => (
  (method === 'GET' || method === 'HEAD')
    ? GLOBAL_READS.some((pattern) => pattern.test(pathname))
    : GLOBAL_MUTATIONS.some((route) => route.method === method && route.pattern.test(pathname))
);

/** The folders a request names, decoded the way OpenCode reads them. */
const directoriesNamedBy = (url, headers) => {
  const directories = [...url.searchParams.getAll('directory'), ...url.searchParams.getAll('location[directory]')];
  const header = headers['x-opencode-directory'];
  if (header) {
    let directory = header;
    if (headers['x-opencode-directory-encoding'] === 'uri' || PERCENT_ESCAPE.test(header)) {
      try {
        directory = decodeURIComponent(header);
      } catch {
        // OpenCode rejects a malformed value; nothing to check.
        directory = '';
      }
    }
    if (directory) directories.push(directory);
  }
  return directories;
};

const lowercaseKeys = (headers) => Object.fromEntries(
  Object.entries(headers ?? {}).map(([name, value]) => [name.toLowerCase(), Array.isArray(value) ? value[0] : value]),
);

const publicAssessment = (assessment, trusted) => ({
  directory: assessment.directory,
  trusted,
  fingerprint: assessment.fingerprint,
  items: assessment.items.map(({ kind, source, name, detail }) => ({ kind, source, name, detail })),
});

/**
 * Whether OpenCode may open a folder. OpenCode imports a folder's plugins and
 * starts its MCP servers the moment a request first names that folder, before
 * any prompt, so a cloned repository or a pull request checked out for review
 * would run its own code unasked. Every runtime that forwards requests to
 * OpenCode asks `refusalFor` first; a folder whose configuration runs code is
 * refused until the user trusts exactly that configuration, and asked again
 * when it changes.
 */
export const createOpenCodeTrust = ({
  storePath,
  homeDirectory = os.homedir(),
  fsPromises = fs.promises,
  now = Date.now,
}) => {
  const store = createOpenCodeTrustStore({ filePath: storePath, fsPromises });
  const cache = new Map();

  const evaluate = async (directory) => {
    const assessment = await assessOpenCodeConfig(directory, { fsPromises, homeDirectory });
    const trusted = assessment.fingerprint === null || await store.has(assessment.repositoryKey, assessment.fingerprint);
    return { assessment, trusted };
  };

  const assess = (directory, { fresh = false } = {}) => {
    const cached = cache.get(directory);
    if (!fresh && cached && now() - cached.at < ASSESSMENT_CACHE_MS) return cached.result;
    const result = evaluate(directory);
    cache.delete(directory);
    cache.set(directory, { at: now(), result });
    if (cache.size > ASSESSMENT_CACHE_LIMIT) cache.delete(cache.keys().next().value);
    result.catch(() => cache.delete(directory));
    return result;
  };

  /** The first of `directories` OpenCode may not open yet, or null. */
  const firstUntrusted = async (directories) => {
    for (const directory of new Set(directories)) {
      const { assessment, trusted } = await assess(directory);
      if (!trusted) return assessment;
    }
    return null;
  };

  const isTrusted = async (directory) => (await assess(directory)).trusted;

  /**
   * Record trust for the configuration the user was shown. When it changed
   * since, nothing is recorded and the current one comes back to be shown.
   */
  const trust = async (directory, fingerprint) => {
    const { assessment, trusted } = await assess(directory, { fresh: true });
    if (assessment.fingerprint !== fingerprint) {
      return { ok: false, assessment: publicAssessment(assessment, trusted) };
    }
    if (!trusted) await store.add(assessment.repositoryKey, assessment.fingerprint);
    cache.delete(directory);
    return { ok: true, assessment: publicAssessment(assessment, true) };
  };

  /**
   * The answer for a request OpenCode must not receive yet, or null to
   * forward it. `resolveSessionDirectory` names the folder of a session whose
   * route runs in that session's own location; it answers null for a session
   * that does not exist and throws when it cannot tell.
   */
  const refusalFor = async ({ method, path: requestPath, headers, resolveSessionDirectory }) => {
    const url = new URL(requestPath, 'http://opencode.invalid');
    const normalizedMethod = String(method || 'GET').toUpperCase();
    if (isGlobalRoute(normalizedMethod, url.pathname)) return null;
    const directories = directoriesNamedBy(url, lowercaseKeys(headers));
    const sessionID = SESSION_SCOPED.exec(url.pathname)?.[1];
    if (sessionID && resolveSessionDirectory) {
      let sessionDirectory;
      try {
        sessionDirectory = await resolveSessionDirectory(decodeURIComponent(sessionID));
      } catch {
        return { status: 503, body: { error: 'Could not check whether this session\'s folder is trusted' } };
      }
      if (sessionDirectory) directories.push(sessionDirectory);
    }
    if (directories.length === 0) return null;
    const untrusted = await firstUntrusted(directories);
    if (!untrusted) return null;
    return {
      status: 403,
      body: { error: TRUST_REQUIRED_ERROR, code: OPENCODE_TRUST_REQUIRED, directory: untrusted.directory },
    };
  };

  /** `GET` and `POST` on {@link OPENCODE_TRUST_ROUTE}, shared by every runtime. */
  const handleRoute = async ({ method, query, body }) => {
    const normalizedMethod = String(method || 'GET').toUpperCase();
    if (normalizedMethod === 'GET') {
      const parsed = trustQuerySchema.safeParse(query);
      if (!parsed.success) return { status: 400, body: { error: 'directory is required' } };
      const { assessment, trusted } = await assess(parsed.data.directory, { fresh: true });
      return { status: 200, body: publicAssessment(assessment, trusted) };
    }
    if (normalizedMethod === 'POST') {
      const parsed = trustAnswerSchema.safeParse(body);
      if (!parsed.success) return { status: 400, body: { error: 'directory and fingerprint are required' } };
      const result = await trust(parsed.data.directory, parsed.data.fingerprint);
      return result.ok
        ? { status: 200, body: result.assessment }
        : { status: 409, body: { error: 'The configuration changed since it was shown', ...result.assessment } };
    }
    return { status: 405, body: { error: 'Method not allowed' } };
  };

  return { assess, isTrusted, firstUntrusted, trust, refusalFor, handleRoute };
};
