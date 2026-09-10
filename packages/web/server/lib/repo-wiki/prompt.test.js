import { describe, expect, it } from 'vitest';

import {
  buildCatalogPrompt,
  buildPagePrompt,
  RESPONSE_FORMAT_INSTRUCTION,
  PROMPT_VERSION,
} from './prompt.js';

const digest = '## Repository files (3 files)\nsrc/index.js\nREADME.md\npackage.json';

describe('repo-wiki prompts', () => {
  it('carries a stable prompt version', () => {
    expect(PROMPT_VERSION).toBe(1);
  });

  it('builds the catalog prompt from repo name, digest, and options', () => {
    const { system, prompt } = buildCatalogPrompt({
      repoName: 'sample',
      digest,
      language: 'en',
      diagrams: true,
    });

    expect(system).toContain('table of contents');
    expect(system).not.toContain('repo-wiki-src://');
    expect(prompt).toContain('Repository: sample');
    expect(prompt).toContain(digest);
    expect(prompt).toContain('Diagrams are enabled');
    expect(prompt).not.toContain('BCP-47');
  });

  it('adds a prose-only language instruction for non-English generation', () => {
    const { prompt } = buildCatalogPrompt({ repoName: 'sample', digest, language: 'zh-CN', diagrams: true });
    expect(prompt).toContain('"zh-CN"');
    expect(prompt).toContain('stay in English');
  });

  it('switches the diagram contract off when diagrams are disabled', () => {
    const enabled = buildPagePrompt({
      repoName: 'sample',
      page: { id: 'flow', title: 'Data flow', purpose: 'How data moves', diagram: 'flow' },
      catalogOutline: '- Data flow',
      pageContext: '### src/index.js\n```\nmain();\n```',
      language: 'en',
      diagrams: true,
    });
    const disabled = buildPagePrompt({
      repoName: 'sample',
      page: { id: 'flow', title: 'Data flow', purpose: '', diagram: null },
      catalogOutline: '- Data flow',
      pageContext: '### src/index.js\n```\nmain();\n```',
      language: 'en',
      diagrams: false,
    });

    expect(enabled.system).toContain('```mermaid');
    expect(enabled.prompt).toContain('Include one flow diagram');
    expect(disabled.system).toContain('Do not include any diagrams');
    expect(disabled.prompt).not.toContain('Include one flow diagram');
  });

  it('keeps the source-reference contract and JSON shape instruction in the page prompt', () => {
    const { system } = buildPagePrompt({
      repoName: 'sample',
      page: { id: 'overview', title: 'Overview', purpose: '', diagram: null },
      catalogOutline: '- Overview',
      pageContext: '### README.md\n```\nhi\n```',
      language: 'en',
      diagrams: true,
    });

    expect(system).toContain('repo-wiki-src://');
    expect(system).toContain('Never cite a file that was not provided');
    expect(system).toContain(RESPONSE_FORMAT_INSTRUCTION.split('\n')[0]);
    expect(system).toContain('never reproduce them');
  });
});
