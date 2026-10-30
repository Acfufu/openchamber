import { afterEach, expect, mock, test } from 'bun:test';

let responsePayload: unknown;
mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch: async () => Response.json(responsePayload) }));
const { fetchQuota } = await import('./fetchQuota');

afterEach(() => mock.restore());

test('quota transport preserves structured Zen values for windows and models', async () => {
  const window = {
    usedPercent: null, remainingPercent: null, windowSeconds: null, resetAfterSeconds: null,
    resetAt: null, resetAtFormatted: null, resetAfterFormatted: null,
  };
  responsePayload = {
    providerId: 'opencode', providerName: 'OpenCode Zen', ok: true, configured: true, fetchedAt: 1,
    usage: {
      windows: {
        daily: { ...window, value: { kind: 'requests', count: 0 } },
        monthly: { ...window, value: { kind: 'spend', spent: 2, limit: 10 } },
      },
      models: { test: { windows: { monthly: { ...window, value: { kind: 'requests', count: 42 } } } } },
    },
  };
  const result = await fetchQuota('opencode');
  expect(result.usage?.windows.daily?.value).toEqual({ kind: 'requests', count: 0 });
  expect(result.usage?.windows.monthly?.value).toEqual({ kind: 'spend', spent: 2, limit: 10 });
  expect(result.usage?.models?.test?.windows.monthly?.value).toEqual({ kind: 'requests', count: 42 });
});
