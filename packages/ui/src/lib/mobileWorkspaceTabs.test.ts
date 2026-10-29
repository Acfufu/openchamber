import { describe, expect, test } from 'bun:test';

import { orderMobileWorkspaceTabs, shownMobileWorkspaceTabs, stripMobileWorkspaceTabs } from './mobileWorkspaceTabs';

describe('mobile workspace tabs', () => {
  test('a saved order keeps its tabs and places tabs it does not name where they go by default', () => {
    expect(orderMobileWorkspaceTabs(['terminal', 'gone', 'changes', 'terminal'])).toEqual(['status', 'files', 'terminal', 'changes', 'notes', 'wiki']);
    expect(orderMobileWorkspaceTabs([])).toEqual(['status', 'changes', 'files', 'terminal', 'notes', 'wiki']);
  });

  test('an order saved before Status existed gets it first and loses the MCP tab', () => {
    expect(orderMobileWorkspaceTabs(['mcp', 'files', 'changes', 'terminal', 'notes'])).toEqual(['status', 'files', 'changes', 'terminal', 'notes', 'wiki']);
  });

  test('hidden tabs leave the strip, but never all of them', () => {
    expect(shownMobileWorkspaceTabs(['files'], ['changes', 'mcp'])).toEqual(['status', 'files', 'terminal', 'notes', 'wiki']);
    // A set that hid every pre-wiki tab leaves the wiki: not empty, so it stands.
    expect(shownMobileWorkspaceTabs([], ['status', 'changes', 'files', 'terminal', 'notes'])).toEqual(['wiki']);
    expect(shownMobileWorkspaceTabs([], ['status', 'changes', 'files', 'terminal', 'notes', 'wiki'])).toEqual(['status', 'changes', 'files', 'terminal', 'notes', 'wiki']);
  });

  test('a hidden tab something opened stays in the strip, in its place, while it is open', () => {
    expect(stripMobileWorkspaceTabs([], ['files', 'terminal'], 'files')).toEqual(['status', 'changes', 'files', 'notes', 'wiki']);
    expect(stripMobileWorkspaceTabs([], ['files', 'terminal'], 'notes')).toEqual(['status', 'changes', 'notes', 'wiki']);
  });
});
