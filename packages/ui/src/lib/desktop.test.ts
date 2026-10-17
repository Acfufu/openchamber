import { afterEach, describe, expect, test } from 'bun:test';

import { isBrowserClientRuntime, isDesktopLocalOriginActive } from './desktop';

describe('browser client runtime', () => {
  test('uses browser file behavior only outside the Electron shell', () => {
    expect(isBrowserClientRuntime('web', false)).toBe(true);
    expect(isBrowserClientRuntime('web', true)).toBe(false);
  });

  test('keeps desktop and VS Code runtime behavior out of browser-only flows', () => {
    expect(isBrowserClientRuntime('desktop', false)).toBe(false);
    expect(isBrowserClientRuntime('vscode', false)).toBe(false);
  });
});

describe('desktop local origin', () => {
  // Bun test runner does not provide `window`.
  const installWindow = (options: { electron: boolean; localOrigin: string; apiBaseUrl: string }) => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: { origin: 'openchamber-ui://app' },
        __OPENCHAMBER_ELECTRON__: options.electron ? { runtime: 'electron' } : undefined,
        __OPENCHAMBER_LOCAL_ORIGIN__: options.localOrigin,
        __OPENCHAMBER_API_BASE_URL__: options.apiBaseUrl,
      },
    });
  };

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'window');
  });

  test("counts the desktop's own server as local", () => {
    installWindow({ electron: true, localOrigin: 'http://127.0.0.1:51761', apiBaseUrl: 'http://127.0.0.1:51761' });
    expect(isDesktopLocalOriginActive()).toBe(true);
  });

  test('counts the same port reached as localhost as local', () => {
    installWindow({ electron: true, localOrigin: 'http://127.0.0.1:51761', apiBaseUrl: 'http://localhost:51761' });
    expect(isDesktopLocalOriginActive()).toBe(true);
  });

  // A server in WSL or a container is reachable on loopback, but its files are
  // not on this machine: actions that hand a path to the local OS stay hidden.
  test('counts a server on another loopback port as remote', () => {
    installWindow({ electron: true, localOrigin: 'http://127.0.0.1:51761', apiBaseUrl: 'http://localhost:3000' });
    expect(isDesktopLocalOriginActive()).toBe(false);
  });

  test('is never local outside the desktop shell', () => {
    installWindow({ electron: false, localOrigin: 'http://127.0.0.1:51761', apiBaseUrl: 'http://127.0.0.1:51761' });
    expect(isDesktopLocalOriginActive()).toBe(false);
  });
});
