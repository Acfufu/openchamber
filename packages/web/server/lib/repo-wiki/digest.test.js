import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildCatalogDigest, buildPageContext, isExcludedPath, listRepoFiles, selectKeyFiles } from './digest.js';

let repoRoot;

const git = (args) => {
  execFileSync('git', args, { cwd: repoRoot, stdio: 'pipe' });
};

const write = (relative, content) => {
  const absolute = path.join(repoRoot, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, 'utf8');
};

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-wiki-digest-'));
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

const seedStandardRepo = () => {
  write('.gitignore', 'node_modules/\ndist/\n');
  write('README.md', '# Sample Repo\n\nA fixture.');
  write('package.json', JSON.stringify({
    name: 'sample',
    main: './src/index.js',
    bin: { sample: './bin/cli.js' },
    scripts: { build: 'vite build' },
  }));
  write('src/index.js', 'export const main = () => 1;\n');
  write('bin/cli.js', '#!/usr/bin/env node\nmain();\n');
  write('src/deep/nested/util.js', 'export const util = 2;\n');
  // Excluded by .gitignore, but present on disk.
  write('node_modules/dep/index.js', 'module.exports = 1;');
  write('dist/bundle.js', '/* built */');
  // Committed files that must be excluded by name rules.
  write('assets/logo.min.js', '/* minified */');
  write('config/.env.production', 'API_KEY=x');
  write('config/deploy.pem', '-----BEGIN');
  git(['add', '.']);
  git(['commit', '-qm', 'fixture']);
};

describe('repo-wiki digest', () => {
  it('lists tracked and untracked files while respecting .gitignore and name exclusions', async () => {
    seedStandardRepo();
    write('notes.txt', 'untracked but not ignored');

    const files = await listRepoFiles(repoRoot);
    const relatives = files.map((file) => file.relative);

    expect(relatives).toContain('src/index.js');
    expect(relatives).toContain('notes.txt');
    expect(relatives).not.toContain('node_modules/dep/index.js');
    expect(relatives).not.toContain('dist/bundle.js');
    expect(relatives).not.toContain('assets/logo.min.js');
    expect(relatives).not.toContain('config/.env.production');
    expect(relatives).not.toContain('config/deploy.pem');
  });

  it('skips symlinks even when tracked', async () => {
    seedStandardRepo();
    fs.symlinkSync(path.join(repoRoot, 'README.md'), path.join(repoRoot, 'link-to-readme.md'));
    git(['add', 'link-to-readme.md']);

    const relatives = (await listRepoFiles(repoRoot)).map((file) => file.relative);
    expect(relatives).not.toContain('link-to-readme.md');
  });

  it('selects root README, manifests, and the entrypoints they name — never scripts', async () => {
    seedStandardRepo();

    const files = await listRepoFiles(repoRoot);
    const selected = (await selectKeyFiles(repoRoot, files)).map((file) => file.relative);

    expect(selected).toContain('README.md');
    expect(selected).toContain('package.json');
    expect(selected).toContain('src/index.js');
    expect(selected).toContain('bin/cli.js');
  });

  it('builds a catalog digest with tree and key file sections', async () => {
    seedStandardRepo();

    const { digest, fileCount } = await buildCatalogDigest({ repoRoot, budgetChars: 100_000 });

    expect(fileCount).toBeGreaterThan(3);
    expect(digest).toContain('## Repository files');
    expect(digest).toContain('src/deep/nested/util.js');
    expect(digest).toContain('## Key files');
    expect(digest).toContain('# Sample Repo');
    expect(digest).toContain('export const main');
    // The minified committed artifact is excluded even from content sections.
    expect(digest).not.toContain('logo.min.js');
  });

  it('refuses with context-too-small instead of truncating the catalog digest', async () => {
    seedStandardRepo();

    const error = await buildCatalogDigest({ repoRoot, budgetChars: 50 }).then(
      () => null,
      (thrown) => thrown,
    );

    expect(error).not.toBeNull();
    expect(error.code).toBe('context-too-small');
    expect(error.requiredChars).toBeGreaterThan(50);
    expect(error.availableChars).toBe(50);
  });

  it('builds page context only from files that exist and pass exclusions', async () => {
    seedStandardRepo();

    const { context } = await buildPageContext({
      repoRoot,
      files: ['src/index.js', 'dist/bundle.js', 'missing.js', '../outside.js'],
      budgetChars: 100_000,
    });

    expect(context).toContain('export const main');
    expect(context).toContain('[not included: excluded path]');
    expect(context).toContain('[not found in repository]');
    expect(context).not.toContain('outside.js');
  });

  it('marks oversized and binary files explicitly instead of failing the digest', async () => {
    write('big.txt', 'x'.repeat(200_000));
    write('blob.bin', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    git(['add', '-f', 'big.txt', 'blob.bin']);
    git(['commit', '-qm', 'oversize']);

    const { context } = await buildPageContext({
      repoRoot,
      files: ['big.txt', 'blob.bin'],
      budgetChars: 400_000,
    });

    expect(context).toContain('[truncated at 98304 of 200000 bytes]');
    expect(context).toContain('[not included: binary file]');
  });

  it('keeps authored files whose names merely contain exclusion substrings', () => {
    expect(isExcludedPath('src/tokenizer.ts')).toBe(false);
    expect(isExcludedPath('src/secretRotator.ts')).toBe(false);
    expect(isExcludedPath('src/keywords.ts')).toBe(false);
    expect(isExcludedPath('secrets/api_key.txt')).toBe(true);
    expect(isExcludedPath('config/tokens.json')).toBe(true);
    expect(isExcludedPath('.env')).toBe(true);
    expect(isExcludedPath('.env.example')).toBe(false);
  });
});
