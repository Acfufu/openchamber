import { describe, expect, it } from 'vitest';

import { runWorkflowSandbox } from './sandbox.js';

const run = (body, { args, onAgent = async ({ prompt }) => `answer to ${prompt}` } = {}) => {
  const phases = [];
  const logs = [];
  const calls = [];
  const sandbox = runWorkflowSandbox({
    body,
    args,
    filename: 'test.workflow.js',
    onAgent: (call) => {
      calls.push(call);
      return onAgent(call);
    },
    onPhase: (title) => phases.push(title),
    onLog: (message) => logs.push(message),
  });
  return { sandbox, phases, logs, calls };
};

describe('runWorkflowSandbox', () => {
  it('runs agents, phases and fan-out, and returns the script value', async () => {
    const { sandbox, phases, calls } = run(`
      phase('Find')
      const first = await agent('list', { label: 'Lister' })
      phase('Audit')
      const audits = await pipeline(args.items, (item) => agent('audit ' + item))
      return { first, audits }
    `, { args: { items: ['a', 'b'] } });
    await expect(sandbox.result).resolves.toEqual({ first: 'answer to list', audits: ['answer to audit a', 'answer to audit b'] });
    expect(phases).toEqual(['Find', 'Audit']);
    expect(calls.map(({ prompt, phase }) => [prompt, phase])).toEqual([['list', 'Find'], ['audit a', 'Audit'], ['audit b', 'Audit']]);
    expect(calls[0].options).toEqual({ label: 'Lister' });
  });

  it('turns a failed agent and a failed task into null and logs the task', async () => {
    const { sandbox, logs } = run(`
      return parallel([
        () => agent('fails'),
        () => { throw new Error('boom') },
        () => agent('works'),
      ])
    `, { onAgent: async ({ prompt }) => { if (prompt === 'fails') throw new Error('no'); return prompt; } });
    await expect(sandbox.result).resolves.toEqual([null, null, 'works']);
    expect(logs).toEqual(['A task in parallel() failed: boom']);
  });

  it('gives the script nothing of the host', async () => {
    const { sandbox } = run('return [typeof require, typeof process, typeof fetch, typeof setTimeout]');
    await expect(sandbox.result).resolves.toEqual(['undefined', 'undefined', 'undefined', 'undefined']);
  });

  it.each(['Math.random()', 'Date.now()', 'new Date()'])('refuses %s, which would break a replay', async (expression) => {
    const { sandbox } = run(`return ${expression}`);
    await expect(sandbox.result).rejects.toThrow(/not available in a workflow/);
  });

  it('keeps dates built from a value', async () => {
    const { sandbox } = run("return new Date('2026-01-02T00:00:00Z').getUTCFullYear()");
    await expect(sandbox.result).resolves.toBe(2026);
  });

  it('rejects with the script error', async () => {
    const { sandbox } = run("throw new Error('script broke')");
    await expect(sandbox.result).rejects.toThrow('script broke');
  });

  it('stops a script that never ends', async () => {
    const { sandbox } = run('while (true) {}');
    sandbox.terminate();
    await expect(sandbox.result).rejects.toMatchObject({ stopped: true });
  });
});
