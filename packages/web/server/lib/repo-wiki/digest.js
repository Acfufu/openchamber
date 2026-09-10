/**
 * Repo digest: the model-facing map of a whole repository.
 *
 * Two tiers, both budget-capped:
 *
 * - **catalog digest** — the repo's file list plus a deterministic key-file
 *   set (root README, root manifests, the entrypoints they name). This is the
 *   input the catalog generation reads to decide what the wiki's pages are and
 *   which files each page needs.
 * - **page context** — the files one page's catalog entry asked for. Per-page
 *   calls read on demand instead of shipping the whole repo every time.
 *
 * Exclusion rules are the safety story, so they lean conservative and are
 * applied by name/pattern, never by size alone: lockfiles and generated
 * artifacts (the walkthrough matcher), dependency/build/cache directories, and
 * files whose names suggest credentials. A false exclusion costs the wiki a
 * detail; a false inclusion can put a secret into a model request.
 *
 * Nothing here truncates silently. A file that does not fit gets an explicit
 * marker; an input that exceeds the budget fails with `context-too-small` so
 * the caller can refuse rather than ship a clipped repo.
 */

import fsp from 'fs/promises';
import path from 'path';
import simpleGit from 'simple-git';

import { isGeneratedArtifact } from '../walkthrough/generated.js';

/** Per-file read cap. Larger files get an explicit truncation marker. */
const MAX_FILE_BYTES = 96 * 1024;

/** Upper bound on deterministic key files, so manifest fan-out stays bounded. */
const MAX_KEY_FILES = 24;

const BINARY_SNIFF_BYTES = 8 * 1024;

/**
 * Directory segments that are dependencies, build output, caches, or runtime
 * state. Matched as whole segments at any depth, so `src/tokenizer.ts`
 * survives while `build/` and `src/build/` do not.
 */
const EXCLUDED_DIR_SEGMENTS = new Set([
  'node_modules', 'vendor', 'dist', 'build', 'out', 'output', 'target',
  '.next', '.nuxt', '.output', '.svelte-kit', '.turbo', '.parcel-cache',
  '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache',
  '.cache', 'coverage', '.nyc_output', 'Pods', '.terraform',
  '.idea', '.gradle', '.pnpm-store',
]);

const ROOT_MANIFEST_FILES = new Set([
  'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'requirements.txt',
  'setup.py', 'setup.cfg', 'Gemfile', 'composer.json', 'pom.xml',
  'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts',
  'pubspec.yaml', 'mix.exs', 'deno.json', 'deno.jsonc', 'meson.build',
  'CMakeLists.txt', 'Makefile',
]);

/**
 * Credential-suggesting names. The word is matched only when it ends the name
 * or is followed by a separator, so `tokenizer.ts` survives while
 * `tokens.json` and `secret_key.pem` do not.
 */
const SECRET_BASENAME_PATTERN = /(^|[-_.])(token|secret|credential|password|passphrase|api[-_]?key)s?([-_.]|$)/i;

const SECRET_FILE_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.jks']);

/** `.env` carries credentials; the example/sample variants are documentation. */
const isEnvSecret = (relativePath) => {
  const name = relativePath.split('/').pop() || '';
  if (!name.startsWith('.env')) return false;
  return !/^\.env\.(example|sample|template)$/i.test(name);
};

export function isExcludedPath(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  if (isEnvSecret(normalized)) return true;

  const segments = normalized.split('/');
  const basename = segments[segments.length - 1] || '';
  if (segments.slice(0, -1).some((segment) => EXCLUDED_DIR_SEGMENTS.has(segment))) return true;
  if (SECRET_BASENAME_PATTERN.test(basename)) return true;
  if (SECRET_FILE_EXTENSIONS.has(path.extname(basename).toLowerCase())) return true;
  if (/^id_rsa|^id_ed25519|^id_ecdsa/.test(basename)) return true;

  return isGeneratedArtifact(normalized);
}

const toPosixRelative = (absolutePath, repoRoot) => {
  const relative = path.relative(repoRoot, absolutePath);
  return relative.split(path.sep).join('/');
};

/**
 * File paths candidate for the digest: tracked plus untracked-but-not-ignored
 * files, with symlinks, non-regular files, and excluded paths dropped.
 */
export async function listRepoFiles(repoRoot) {
  const git = simpleGit({ baseDir: repoRoot });
  const raw = await git.raw(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  const candidates = new Set(raw.split('\0').filter(Boolean));

  const files = [];
  for (const relative of candidates) {
    if (relative.split('/').includes('..') || path.isAbsolute(relative)) continue;
    if (isExcludedPath(relative)) continue;

    const absolute = path.join(repoRoot, relative);
    let stat;
    try {
      stat = await fsp.lstat(absolute);
    } catch {
      continue;
    }
    // Symlinks are skipped entirely: their targets can leave the repository,
    // and no wiki claim should rest on a file the repo does not contain.
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    files.push({ relative, absolute, size: stat.size });
  }

  files.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
  return files;
}

/**
 * Read one repo file as text, capped and sniffed. Returns either
 * `{ content }` (possibly with an explicit truncation marker) or
 * `{ skipped: reason }` for binary/unreadable files — never a silent gap.
 */
const readTextFile = async (file) => {
  const cappedSize = Math.min(file.size, MAX_FILE_BYTES);
  const buffer = Buffer.alloc(cappedSize);
  const handle = await fsp.open(file.absolute, 'r');
  try {
    const { bytesRead } = await handle.read(buffer, 0, cappedSize, 0);
    if (buffer.subarray(0, Math.min(bytesRead, BINARY_SNIFF_BYTES)).includes(0)) {
      return { skipped: 'binary file' };
    }
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    if (file.size > MAX_FILE_BYTES) {
      return { content: `${text}\n[truncated at ${MAX_FILE_BYTES} of ${file.size} bytes]` };
    }
    return { content: text };
  } catch (error) {
    return { skipped: `unreadable (${error?.code || 'error'})` };
  } finally {
    await handle.close();
  }
};

const formatFileSection = (relative, outcome) => {
  if (outcome.skipped) {
    return `### ${relative}\n[not included: ${outcome.skipped}]`;
  }
  return `### ${relative}\n\`\`\`\n${outcome.content}\n\`\`\``;
};

/**
 * Key files are a deterministic function of the repo's root: every run over
 * the same repository state reads the same input.
 */
export const selectKeyFiles = async (repoRoot, files) => {
  const byRelative = new Map(files.map((file) => [file.relative, file]));
  const selected = [];

  const take = (relative) => {
    if (selected.length >= MAX_KEY_FILES) return;
    const file = byRelative.get(relative);
    if (file && !selected.includes(file)) selected.push(file);
  };

  for (const file of files) {
    if (!file.relative.includes('/') && (/^readme(\.|$)/i.test(file.relative) || ROOT_MANIFEST_FILES.has(file.relative))) {
      take(file.relative);
    }
  }

  const packageJson = byRelative.get('package.json');
  if (packageJson) {
    try {
      const parsed = JSON.parse(await fsp.readFile(packageJson.absolute, 'utf8'));
      const entryNames = [];
      // Classify JSON node kinds by constructor: strings are the entrypoint
      // candidates, arrays and plain objects are walked, everything else is
      // noise.
      const collectEntryPaths = (value) => {
        if (entryNames.length >= 32) return;
        if (value == null) return;
        if (value.constructor === String) {
          entryNames.push(value);
        } else if (Array.isArray(value)) {
          value.forEach(collectEntryPaths);
        } else if (value.constructor === Object) {
          Object.values(value).forEach(collectEntryPaths);
        }
      };
      // `scripts` values are shell commands, not file paths, so they are
      // deliberately not mined for entrypoints.
      collectEntryPaths(parsed.main);
      collectEntryPaths(parsed.module);
      collectEntryPaths(parsed.browser);
      collectEntryPaths(parsed.bin);
      collectEntryPaths(parsed.exports);

      for (const entry of entryNames) {
        const normalized = String(entry).replace(/^\.\//, '').split('?')[0].split('#')[0];
        if (!normalized || normalized.includes('..')) continue;
        // Only exact repo files qualify — patterns like "dist/*" resolve
        // against build output that exclusions drop anyway.
        take(normalized);
      }
    } catch {
      // An unreadable package.json still leaves the README and tree.
    }
  }

  return selected;
};

const assertWithinBudget = (text, budgetChars, what) => {
  const requiredChars = text.length;
  if (requiredChars > budgetChars) {
    const error = new Error(
      `repo digest needs ${requiredChars} chars but the resolved model input budget is ${budgetChars} — pick a roomier model`,
    );
    error.code = 'context-too-small';
    error.requiredChars = requiredChars;
    error.availableChars = budgetChars;
    error.subject = what;
    throw error;
  }
};

/**
 * Build the catalog digest. Throws `context-too-small` (with requiredChars /
 * availableChars) when the tree plus key files exceed the budget.
 */
export async function buildCatalogDigest({ repoRoot, budgetChars }) {
  const files = await listRepoFiles(repoRoot);
  const keyFiles = await selectKeyFiles(repoRoot, files);

  const tree = files.map((file) => file.relative).join('\n');
  const sections = [];
  for (const file of keyFiles) {
    const outcome = await readTextFile(file);
    sections.push(formatFileSection(file.relative, outcome));
  }

  const digest = [
    `## Repository files (${files.length} files, exclusions applied)`,
    tree,
    '',
    '## Key files',
    ...sections,
  ].join('\n');

  assertWithinBudget(digest, budgetChars, 'catalog digest');
  return { digest, fileCount: files.length, keyFilePaths: keyFiles.map((file) => file.relative) };
}

/**
 * Build one page's file context from the paths its catalog entry requested.
 * `files` holds page file paths as strings, already validated by the catalog
 * schema normalizer — this layer owns normalization and containment, not
 * string-ness. Paths are containment-checked against the repo root, and
 * exclusion rules still apply.
 */
export async function buildPageContext({ repoRoot, files, budgetChars }) {
  const available = new Map((await listRepoFiles(repoRoot)).map((file) => [file.relative, file]));
  const resolved = [];

  for (const requested of files) {
    if (!requested) continue;
    const normalized = toPosixRelative(path.resolve(repoRoot, requested.replace(/^\.\//, '')), repoRoot);
    if (normalized === '..' || normalized.startsWith('../') || path.isAbsolute(normalized)) continue;
    if (isExcludedPath(normalized)) {
      resolved.push(`### ${normalized}\n[not included: excluded path]`);
      continue;
    }
    const file = available.get(normalized);
    if (!file) {
      resolved.push(`### ${normalized}\n[not found in repository]`);
      continue;
    }
    resolved.push(formatFileSection(normalized, await readTextFile(file)));
  }

  const context = resolved.join('\n\n');
  assertWithinBudget(context, budgetChars, 'page context');
  return { context, resolvedPaths: resolved.length };
}
