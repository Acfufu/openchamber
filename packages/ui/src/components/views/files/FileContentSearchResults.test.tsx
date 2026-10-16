import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { FileContentSearchResults } from './FileContentSearchResults';
import type { FileContentSearchState } from './useFileContentSearch';

const render = (state: FileContentSearchState) => renderToStaticMarkup(
  <I18nProvider>
    <FileContentSearchResults state={state} selectedPath={null} onOpen={() => {}} />
  </I18nProvider>,
);

describe('FileContentSearchResults', () => {
  test('says there are no matches only for a search that finished', () => {
    expect(render({ status: 'results', matches: [], stopped: null })).toContain('No matches.');
  });

  test('says the search stopped when the deadline came before any match', () => {
    const markup = render({ status: 'results', matches: [], stopped: 'deadline' });
    expect(markup).not.toContain('No matches.');
    expect(markup).toContain('stopped after 30 seconds');
  });
});
