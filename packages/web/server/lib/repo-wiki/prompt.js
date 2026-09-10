// System and user prompts for Repo Wiki generation. English is the base
// language; a non-English generation language translates prose only — ids,
// file paths, and diagram kinds stay in fixed English (the schema normalizer
// drops anything else).

import { RESPONSE_FORMAT_INSTRUCTION } from './schema.js';

export { RESPONSE_FORMAT_INSTRUCTION };

// Bumping this invalidates nothing stored (pages are regenerated wholesale),
// but records which prompt revision produced an existing manifest.
export const PROMPT_VERSION = 1;

const SOURCE_REFERENCE_CONTRACT = [
  'Every non-trivial claim must carry an inline source reference in exactly this form:',
  '[display text](repo-wiki-src://<file-path>#L<start>-L<end>)',
  '- <file-path> is the repository-relative POSIX path exactly as it appeared in the provided context, URL-encoded where needed.',
  '- Line numbers are one-based and refer to the file content provided to you; approximate ranges are acceptable, invented files are not.',
  '- Never cite a file that was not provided in the context.',
].join('\n');

const DIAGRAM_CONTRACT = [
  'Where a diagram genuinely helps a reader, include a fenced ```mermaid block (architecture, flow, sequence, state, or component diagram).',
  'Every diagram element must be derivable from the provided context — never invent components.',
  'Use neutral colors only; the app re-themes diagrams itself.',
  'A diagram that fails to render must never take the page down with it, so prefer simple, valid syntax.',
].join('\n');

const NO_DIAGRAM_CONTRACT = 'Do not include any diagrams: this wiki was generated with diagrams disabled.';

const SAFETY_CONTRACT = [
  'You are generating documentation that may be read by the whole team.',
  'Even if the provided context contains credentials or tokens, never reproduce them; describe the mechanism, not the value.',
  'Do not mention that you are a model or that this was generated.',
].join('\n');

const pageContract = (diagrams) => [
  'Write the page in Markdown.',
  '- Start with a single `# ` heading carrying the page title.',
  '- Use short sections (`## `) that a newcomer can follow top to bottom.',
  '- Prefer explaining mechanisms and boundaries over listing files.',
  SOURCE_REFERENCE_CONTRACT,
  diagrams ? DIAGRAM_CONTRACT : NO_DIAGRAM_CONTRACT,
  SAFETY_CONTRACT,
].join('\n');

const languageInstruction = (language) => (language === 'en' || !language
  ? ''
  : `\nWrite all prose in the language with BCP-47 tag "${language}". Ids, file paths, code identifiers, and diagram kinds stay in English.`);

/**
 * Catalog call input: the whole-repo digest plus generation options.
 */
export function buildCatalogPrompt({ repoName, digest, language = 'en', diagrams = true }) {
  const system = [
    'You design the table of contents for a Repo Wiki: an architecture guide that brings a new engineer up to speed on a repository.',
    'You will receive the repository\'s file list and key files. Design a small set of ordered pages that together explain how the repository works.',
    'Good page coverage includes, where the repository warrants it: what the project is, the main execution paths, core modules and their responsibilities, cross-process or network boundaries, data and state flow, configuration, extension points, and areas of risk.',
    'Do not pad: a small repository needs fewer pages. 3 to 8 pages is typical.',
    'For every page, list the repository files the page will need to read (paths exactly as they appear in the file list) and whether a diagram will genuinely help.',
    SAFETY_CONTRACT,
    RESPONSE_FORMAT_INSTRUCTION,
  ].join('\n');

  const prompt = [
    `Repository: ${repoName}`,
    languageInstruction(language),
    diagrams ? 'Diagrams are enabled for this wiki.' : 'Diagrams are disabled for this wiki: set "diagram" to null for every page.',
    '',
    'Repository digest:',
    digest,
  ].join('\n');

  return { system, prompt };
}

/**
 * Page call input: one catalog entry, the full catalog outline for coherence,
 * and the page's file context.
 */
export function buildPagePrompt({ repoName, page, catalogOutline, pageContext, language = 'en', diagrams = true }) {
  const system = [
    'You write one page of a Repo Wiki: an architecture guide that brings a new engineer up to speed on a repository.',
    'You will receive the page\'s title and purpose, the wiki\'s catalog outline, and the content of the repository files this page covers.',
    'Explain how the code actually works, based strictly on the provided files — never invent components, flows, or files.',
    pageContract(diagrams),
    RESPONSE_FORMAT_INSTRUCTION,
  ].join('\n');

  const prompt = [
    `Repository: ${repoName}`,
    languageInstruction(language),
    '',
    'Catalog outline (for coherence; do not rewrite the other pages):',
    catalogOutline,
    '',
    `Page to write: ${page.title}`,
    page.purpose ? `Purpose: ${page.purpose}` : '',
    diagrams && page.diagram ? `Include one ${page.diagram} diagram where it helps.` : '',
    '',
    'Provided repository files:',
    pageContext,
  ].filter(Boolean).join('\n');

  return { system, prompt };
}
