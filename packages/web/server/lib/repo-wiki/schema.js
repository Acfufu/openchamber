// Shape of the Repo Wiki the model must produce, plus normalization of what it
// actually produced. The model is only trusted for prose and structure choice
// — ids, file paths, and diagram kinds are re-validated here against fixed
// English values, so a page generated in another language cannot silently
// lose its anchors the way a translated enum would.

export const MAX_CATALOG_PAGES = 24;
export const MAX_FILES_PER_PAGE = 12;
export const MAX_PAGE_TITLE_CHARS = 80;
export const MAX_PAGE_PURPOSE_CHARS = 200;
export const MAX_PAGE_MARKDOWN_CHARS = 64 * 1024;

/** Fixed English values: a model writing Ukrainian prose still emits these. */
export const DIAGRAM_KINDS = ['architecture', 'flow', 'sequence', 'state', 'component'];

export const catalogResponseSchema = {
  type: 'object',
  properties: {
    pages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          purpose: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          diagram: { type: ['string', 'null'], enum: [...DIAGRAM_KINDS, null] },
        },
        required: ['id', 'title', 'purpose', 'files', 'diagram'],
        additionalProperties: false,
      },
    },
  },
  required: ['pages'],
  additionalProperties: false,
};

export const pageResponseSchema = {
  type: 'object',
  properties: {
    markdown: { type: 'string' },
  },
  required: ['markdown'],
  additionalProperties: false,
};

/** Appended to the system prompt when a provider refuses response schemas. */
export const RESPONSE_FORMAT_INSTRUCTION = [
  'Respond with ONLY a JSON object — no prose around it, no markdown fence.',
  'Catalog calls must return: {"pages": [{"id": string, "title": string, "purpose": string, "files": string[], "diagram": "architecture"|"flow"|"sequence"|"state"|"component"|null}]}',
  'Page calls must return: {"markdown": string}.',
].join('\n');

const asString = (value, max = 0) => {
  if (value == null || value.constructor !== String) return '';
  const trimmed = value.trim();
  if (max > 0 && trimmed.length > max) return trimmed.slice(0, max);
  return trimmed;
};

const asRecord = (value) => {
  if (value == null || Array.isArray(value) || value.constructor !== Object) return null;
  return value;
};

const SLUG_INVALID = /[^a-z0-9-]+/g;

const asPageId = (value, usedIds) => {
  const raw = asString(value, 64).toLowerCase();
  const slug = raw.replace(SLUG_INVALID, '-').replace(/^-+|-+$/g, '');
  if (!slug || usedIds.has(slug)) return null;
  usedIds.add(slug);
  return slug;
};

const asFileList = (value) => {
  const files = [];
  for (const entry of Array.isArray(value) ? value : []) {
    if (files.length >= MAX_FILES_PER_PAGE) break;
    const candidate = asString(entry, 512);
    if (!candidate) continue;
    const posix = candidate.replace(/\\/g, '/').replace(/^\.\//, '');
    if (posix.startsWith('/') || posix.split('/').includes('..')) continue;
    if (files.includes(posix)) continue;
    files.push(posix);
  }
  return files;
};

/**
 * Turn a raw catalog response into ordered, id-unique pages. Unusable entries
 * are dropped individually; only an empty catalog fails the run.
 */
export function normalizeCatalog(raw) {
  const record = asRecord(raw);
  if (!record) {
    throw Object.assign(new Error('Model returned no catalog object'), { code: 'invalid-repo-wiki' });
  }

  const usedIds = new Set();
  const pages = [];
  let dropped = 0;

  for (const entry of Array.isArray(record.pages) ? record.pages : []) {
    if (pages.length >= MAX_CATALOG_PAGES) break;
    const page = asRecord(entry);
    if (!page) {
      dropped += 1;
      continue;
    }

    const id = asPageId(page.id, usedIds);
    const title = asString(page.title, MAX_PAGE_TITLE_CHARS);
    if (!id || !title) {
      dropped += 1;
      continue;
    }

    pages.push({
      id,
      title,
      purpose: asString(page.purpose, MAX_PAGE_PURPOSE_CHARS),
      files: asFileList(page.files),
      diagram: DIAGRAM_KINDS.includes(page.diagram) ? page.diagram : null,
    });
  }

  if (pages.length === 0) {
    throw Object.assign(new Error('Model returned no usable catalog pages'), { code: 'invalid-repo-wiki' });
  }

  return { pages, dropped };
}

/**
 * Turn a raw page response into page markdown. The markdown is prose written
 * by the model — the source references inside it are the renderer's contract,
 * not a schema concern.
 */
export function normalizePage(raw) {
  const record = asRecord(raw);
  const markdown = record ? asString(record.markdown, MAX_PAGE_MARKDOWN_CHARS) : '';
  if (!markdown) {
    throw Object.assign(new Error('Model returned no usable page content'), { code: 'invalid-repo-wiki' });
  }
  return { markdown };
}

/**
 * Extract a JSON object from a model response that may or may not honour the
 * schema — some providers wrap it in prose or a fenced block.
 */
export function parseModelJson(text) {
  if (!text || text.constructor !== String || !text.trim()) {
    throw Object.assign(new Error('Model returned an empty response'), { code: 'invalid-repo-wiki' });
  }

  const withoutFence = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

  try {
    return JSON.parse(withoutFence);
  } catch {
    // Fall through to a bounded scan for the outermost object.
  }

  const start = withoutFence.indexOf('{');
  if (start === -1) {
    throw Object.assign(new Error('Model response contained no JSON object'), { code: 'invalid-repo-wiki' });
  }

  for (let end = withoutFence.lastIndexOf('}'); end > start; end = withoutFence.lastIndexOf('}', end - 1)) {
    try {
      return JSON.parse(withoutFence.slice(start, end + 1));
    } catch {
      // Keep shrinking from the right.
    }
  }

  throw Object.assign(new Error('Model response was not valid JSON'), { code: 'invalid-repo-wiki' });
}
