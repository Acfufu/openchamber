import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true,
});
// React DOM and the i18n store read the DOM when imported, so it goes in first.
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { PdfArtifact } = await import('./PdfArtifact');

const SRC = 'http://h/api/fs/raw?path=report.pdf&oc_url_token=t';

let reactRoot: Root | null = null;
let container: HTMLElement | null = null;

const render = async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  reactRoot = createRoot(container);
  await act(async () => reactRoot?.render(
    <I18nProvider>
      <PdfArtifact src={SRC} name="report.pdf" path="/w/report.pdf" sizeBytes={2048} download={<button type="button">Save file</button>} />
    </I18nProvider>,
  ));
};

const setNativePlatform = (platform: string | null) => {
  if (platform) Reflect.set(window, 'Capacitor', { getPlatform: () => platform });
  else Reflect.deleteProperty(window, 'Capacitor');
};

afterEach(async () => {
  await act(async () => reactRoot?.unmount());
  container?.remove();
  reactRoot = null;
  container = null;
  setNativePlatform(null);
});

describe('PdfArtifact', () => {
  test('the Android app shows the file and its download instead of an empty frame', async () => {
    setNativePlatform('android');
    await render();
    expect(container?.querySelector('iframe')).toBeNull();
    expect(container?.textContent).toContain('report.pdf');
    expect(container?.textContent).toContain("PDF preview isn't available on Android");
    expect(container?.querySelector('button')?.textContent).toBe('Save file');
  });

  test('other runtimes open the PDF in the browser viewer', async () => {
    for (const platform of [null, 'ios']) {
      setNativePlatform(platform);
      await render();
      expect(container?.querySelector('iframe')?.getAttribute('src')).toBe(SRC);
      expect(container?.textContent).not.toContain('Android');
      await act(async () => reactRoot?.unmount());
      container?.remove();
    }
  });
});
