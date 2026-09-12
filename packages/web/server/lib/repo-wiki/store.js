/**
 * Repo Wiki storage: one AI-generated architecture wiki per project, kept
 * app-side under `<dataDir>/repo-wiki/<projectId>/` — never inside the user's
 * repository. The wiki is a derived, regenerable artifact; writing it into the
 * repo would pollute every project's git status.
 *
 * Layout:
 *
 *   repo-wiki/<projectId>/manifest.json    catalog, run state, generation metadata
 *   repo-wiki/<projectId>/pages/<pageId>.md
 *
 * Invariants:
 *
 * - Every write is atomic (tmp + rename), so a crash mid-write leaves the
 *   previous state parseable rather than a half-written file.
 * - A run still marked `running` after a server restart did not survive: it is
 *   marked `stopped` on recovery, keeping every finished page readable.
 * - The store owns placement and integrity only. It never interprets catalog
 *   or run semantics — callers decide what status transitions mean.
 */

import fsp from 'fs/promises';
import path from 'path';

export const REPO_WIKI_VERSION = 1;

/** Same charset agent-memory accepts for projectIds (`path_<base64url>` fits). */
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9._:-]+$/;

/**
 * Page ids come from generated catalog output, so they are untrusted input.
 * The pattern excludes path separators and the id is always suffixed with
 * `.md`, so the final segment is one plain filename inside `pages/` — dots
 * alone cannot form a traversal segment.
 */
const PAGE_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

export const MANIFEST_FILE = 'manifest.json';

/**
 * Route-level guard: reject malformed project ids before touching the store.
 * A bare `.` or `..` passes the charset but `path.join` normalizes it to the
 * store root or above it, so both are rejected before the pattern is trusted.
 */
export const isValidProjectId = (value) => value != null
  && value.constructor === String
  && value.length > 0
  && value !== '.'
  && value !== '..'
  && PROJECT_ID_PATTERN.test(value);

/** Route-level guard for page ids (same traversal argument as pagePath). */
export const isValidPageId = (value) => value != null
  && value.constructor === String
  && value.length > 0
  && PAGE_ID_PATTERN.test(value);

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;

export const createRepoWikiStore = ({ dataDir }) => {
  if (dataDir == null || dataDir === '') {
    throw new Error('dataDir is required');
  }

  const rootDir = path.join(path.resolve(dataDir), 'repo-wiki');

  const projectDir = (projectId) => {
    if (!isValidProjectId(projectId)) {
      throw new Error('projectId contains unsupported characters');
    }
    const resolved = path.join(rootDir, projectId);
    // The charset admits no separators, so a valid id is always one direct
    // child of the store root; containment is asserted anyway, because
    // placement and deletion must never rest on the pattern alone.
    if (!resolved.startsWith(rootDir + path.sep)) {
      throw new Error('projectId must resolve inside the wiki store');
    }
    return resolved;
  };

  const manifestPath = (projectId) => path.join(projectDir(projectId), MANIFEST_FILE);

  const pagePath = (projectId, pageId) => {
    if (pageId == null || !PAGE_ID_PATTERN.test(pageId)) {
      throw new Error('pageId contains unsupported characters');
    }
    return path.join(projectDir(projectId), 'pages', `${pageId}.md`);
  };

  const writeJsonAtomic = async (filePath, value) => {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
      await fsp.rename(tmp, filePath);
    } catch (error) {
      await fsp.unlink(tmp).catch(() => {});
      throw error;
    }
  };

  const writePageAtomic = async (filePath, markdown) => {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fsp.writeFile(tmp, markdown, 'utf8');
      await fsp.rename(tmp, filePath);
    } catch (error) {
      await fsp.unlink(tmp).catch(() => {});
      throw error;
    }
  };

  const readJson = async (filePath, maxBytes) => {
    let raw;
    try {
      const stat = await fsp.stat(filePath);
      if (!stat.isFile() || stat.size > maxBytes) return null;
      raw = await fsp.readFile(filePath, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
    try {
      return JSON.parse(raw);
    } catch {
      // Corrupt means unusable, same as missing — never throw at readers.
      return null;
    }
  };

  const readManifest = async (projectId) => {
    const manifest = await readJson(manifestPath(projectId), MAX_MANIFEST_BYTES);
    // A null, an array, or any non-manifest record fails the version check,
    // which is the one field every writer stamps.
    if (!manifest || manifest.wikiVersion !== REPO_WIKI_VERSION) {
      return null;
    }
    return manifest;
  };

  const writeManifest = async (projectId, manifest) => {
    if (!manifest || Array.isArray(manifest)) {
      throw new Error('manifest must be an object');
    }
    await writeJsonAtomic(manifestPath(projectId), { wikiVersion: REPO_WIKI_VERSION, ...manifest });
  };

  const readPage = async (projectId, pageId) => {
    const filePath = pagePath(projectId, pageId);
    try {
      const stat = await fsp.stat(filePath);
      if (!stat.isFile() || stat.size > MAX_PAGE_BYTES) return null;
      return await fsp.readFile(filePath, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
  };

  const writePage = async (projectId, pageId, markdown) => {
    if (!markdown) {
      throw new Error('page content must be a non-empty string');
    }
    await writePageAtomic(pagePath(projectId, pageId), markdown);
  };

  const deleteWiki = async (projectId) => {
    // Only ever removes this project's own subtree under the app data root.
    await fsp.rm(projectDir(projectId), { recursive: true, force: true });
  };

  /**
   * Runs once per process (from route registration). Any manifest still in a
   * `running` run state belongs to a generation that died with the previous
   * server process: mark it stopped, keep finished pages.
   */
  const recoverInterruptedRuns = async () => {
    let names;
    try {
      names = await fsp.readdir(rootDir);
    } catch {
      return 0;
    }

    let recovered = 0;
    for (const name of names) {
      let manifest;
      try {
        manifest = await readManifest(name);
      } catch {
        continue;
      }
      if (!manifest || manifest.run?.status !== 'running') continue;
      try {
        await writeManifest(name, {
          ...manifest,
          run: {
            ...manifest.run,
            status: 'stopped',
            finishedAt: new Date().toISOString(),
            error: 'interrupted by server restart',
          },
        });
        recovered += 1;
      } catch {
        // Leave it; a stale `running` manifest reads as a finished-with-holes
        // wiki until the next successful write.
      }
    }
    return recovered;
  };

  return {
    rootDir,
    readManifest,
    writeManifest,
    readPage,
    writePage,
    deleteWiki,
    recoverInterruptedRuns,
  };
};

export const __testing = { PROJECT_ID_PATTERN, PAGE_ID_PATTERN, MAX_MANIFEST_BYTES, MAX_PAGE_BYTES };
