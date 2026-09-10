import { describe, expect, it } from 'vitest';

import {
  DIAGRAM_KINDS,
  MAX_CATALOG_PAGES,
  RESPONSE_FORMAT_INSTRUCTION,
  normalizeCatalog,
  normalizePage,
  parseModelJson,
} from './schema.js';

const validPage = {
  id: 'Overview',
  title: 'Overview',
  purpose: 'What the project is',
  files: ['README.md', './src/index.js', 'src/../leak.js', '/etc/passwd', 'README.md'],
  diagram: 'architecture',
};

describe('repo-wiki schema', () => {
  describe('normalizeCatalog', () => {
    it('normalizes ids, files, and diagram kinds from a valid catalog', () => {
      const { pages, dropped } = normalizeCatalog({ pages: [validPage] });
      expect(dropped).toBe(0);
      expect(pages).toHaveLength(1);
      expect(pages[0]).toMatchObject({
        id: 'overview',
        title: 'Overview',
        purpose: 'What the project is',
        diagram: 'architecture',
      });
      // Relative, deduplicated, no traversal, no absolute paths.
      expect(pages[0].files).toEqual(['README.md', 'src/index.js']);
    });

    it('drops unusable page entries individually and reports the count', () => {
      const { pages, dropped } = normalizeCatalog({
        pages: [null, { title: 'no id' }, validPage, { ...validPage, id: 'overview', title: 'dup' }],
      });
      expect(pages.map((page) => page.id)).toEqual(['overview']);
      expect(dropped).toBe(3);
    });

    it('caps the catalog at the maximum page count', () => {
      const pages = Array.from({ length: MAX_CATALOG_PAGES + 5 }, (_, index) => ({
        ...validPage,
        id: `page-${index}`,
      }));
      const result = normalizeCatalog({ pages });
      expect(result.pages).toHaveLength(MAX_CATALOG_PAGES);
    });

    it('maps translated diagram kinds to null instead of dropping the page', () => {
      const { pages } = normalizeCatalog({
        pages: [{ ...validPage, id: 'flow', diagram: '架构图' }],
      });
      expect(pages[0].diagram).toBeNull();
      expect(DIAGRAM_KINDS).not.toContain('架构图');
    });

    it('throws invalid-repo-wiki when nothing usable remains', () => {
      expect(() => normalizeCatalog({ pages: [] })).toThrow(/no usable catalog/);
      expect(() => normalizeCatalog('prose')).toThrow(/no catalog object/);
    });
  });

  describe('normalizePage', () => {
    it('returns trimmed markdown', () => {
      expect(normalizePage({ markdown: '  # Title\n\nBody.  ' }).markdown).toBe('# Title\n\nBody.');
    });

    it('throws invalid-repo-wiki on empty or non-object responses', () => {
      expect(() => normalizePage({ markdown: '   ' })).toThrow(/no usable page/);
      expect(() => normalizePage(null)).toThrow(/no usable page/);
    });
  });

  describe('parseModelJson', () => {
    it('parses plain, fenced, and prose-wrapped JSON', () => {
      const payload = { pages: [] };
      expect(parseModelJson(JSON.stringify(payload))).toEqual(payload);
      expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
      expect(parseModelJson('Here you are:\n{"a":2}\nDone.')).toEqual({ a: 2 });
    });

    it('throws invalid-repo-wiki on empty or non-JSON responses', () => {
      expect(() => parseModelJson('   ')).toThrow(/empty response/);
      expect(() => parseModelJson('no json here')).toThrow(/no JSON object/);
      expect(() => parseModelJson('{"broken": ')).toThrow(/not valid JSON/);
    });
  });

  it('describes both call shapes in the schema fallback instruction', () => {
    expect(RESPONSE_FORMAT_INSTRUCTION).toContain('"pages"');
    expect(RESPONSE_FORMAT_INSTRUCTION).toContain('"markdown"');
  });
});
