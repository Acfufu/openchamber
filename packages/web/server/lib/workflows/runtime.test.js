import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { WorkflowAgentStopped } from './agent-session.js';
import { createWorkflowRuntime } from './runtime.js';
import { createWorkflowRunStore } from './store.js';

const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const waitFor = async (check, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/**
 * Agent sessions without OpenCode: `answer(prompt, attempt)` decides each
 * reply. A prompt listed in `hang` runs until the run stops it.
 */
const fakeAgentSessions = ({ answer = (prompt) => `done: ${prompt}`, hang = [] } = {}) => {
  let nextSession = 0;
  let running = 0;
  const fake = {
    started: [],
    followUps: [],
    interrupted: [],
    maxRunning: 0,
    reports: [],
    start: async ({ text, signal, onSession }) => {
      nextSession += 1;
      const sessionId = `ses_agent${nextSession}`;
      fake.started.push(text);
      onSession(sessionId);
      running += 1;
      fake.maxRunning = Math.max(fake.maxRunning, running);
      try {
        if (hang.some((prompt) => text.startsWith(prompt))) {
          await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new WorkflowAgentStopped()), { once: true }));
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        const reply = answer(text, fake.started.filter((prompt) => prompt === text).length);
        return { sessionId, outcome: reply === null ? { state: 'error', text: '', errorMessage: 'agent failed' } : { state: 'completed', text: reply, errorMessage: '' } };
      } finally {
        running -= 1;
      }
    },
    followUp: async ({ text }) => {
      fake.followUps.push(text);
      return { state: 'completed', text: '{"files":["a.ts"]}', errorMessage: '' };
    },
    interrupt: async (_, sessionId) => {
      fake.interrupted.push(sessionId);
    },
  };
  return fake;
};

const setup = async (agentSessions, options = {}) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-workflows-'));
  directories.push(dataDir);
  const store = createWorkflowRunStore({ fsPromises: fs, path, dataDir });
  const events = [];
  const runtime = createWorkflowRuntime({
    store,
    agentSessions,
    postSynthetic: async (sessionId, body) => {
      agentSessions.reports.push({ sessionId, body });
    },
    broadcast: (event) => events.push(event),
    fsPromises: fs,
    path,
    sleep: async () => {},
    ...options,
  });
  const scope = { sessionId: 'ses_parent', directory: dataDir };
  const act = (action, input = {}) => runtime.executeAction(action, input, scope);
  const finished = (runId) => waitFor(async () => {
    const status = await act('workflow.status', { runId });
    return ['completed', 'failed', 'stopped', 'declined'].includes(status.state) && agentSessions.reports.some((report) => report.body.metadata.runId === runId) ? status : null;
  });
  return { runtime, store, events, act, finished, dataDir };
};

const script = (body, phases = "['Work']") => `export const meta = { name: 'test-flow', description: 'A test', phases: ${phases} }\n${body}`;

describe('workflow runtime', () => {
  it('waits for approval, runs the agents and reports into the session', async () => {
    const agents = fakeAgentSessions();
    const { runtime, act, finished, events } = await setup(agents);
    const proposed = await act('workflow.run', { script: script("phase('Work')\nreturn pipeline(args.items, (item) => agent('check ' + item))"), args: { items: ['a', 'b'] } });
    expect(proposed).toMatchObject({ state: 'awaiting-approval', name: 'test-flow', phases: ['Work'] });
    expect(agents.started).toEqual([]);

    await runtime.approve({ runId: proposed.runId });
    const status = await finished(proposed.runId);

    expect(status.state).toBe('completed');
    expect(status.agents.map((agent) => [agent.label, agent.phase, agent.state])).toEqual([['check a', 'Work', 'completed'], ['check b', 'Work', 'completed']]);
    const [report] = agents.reports;
    expect(report.sessionId).toBe('ses_parent');
    expect(report.body).toMatchObject({ resume: true, delivery: 'steer', metadata: { source: 'openchamber-workflow', runId: proposed.runId, state: 'completed' } });
    expect(report.body.text).toContain('done: check a');
    expect(events.some((event) => event.type === 'openchamber:workflow-run' && event.properties.run.state === 'completed')).toBe(true);
    expect(await act('workflow.result', { runId: proposed.runId, agent: status.agents[1].sessionId })).toMatchObject({ agent: { result: 'done: check b' } });
  });

  it('keeps at most the concurrency limit of agents working', async () => {
    const agents = fakeAgentSessions();
    const { runtime, act, finished } = await setup(agents, { maxConcurrentAgents: 2 });
    const { runId } = await act('workflow.run', { script: script("return parallel([1, 2, 3, 4, 5].map((n) => () => agent('n' + n)))") });
    await runtime.approve({ runId });
    await finished(runId);
    expect(agents.started).toHaveLength(5);
    expect(agents.maxRunning).toBe(2);
  });

  it('asks again in the same session until the answer matches the schema', async () => {
    const agents = fakeAgentSessions({ answer: () => 'not json' });
    const { runtime, act, finished } = await setup(agents);
    const schema = "{ type: 'object', required: ['files'], properties: { files: { type: 'array' } } }";
    const { runId } = await act('workflow.run', { script: script(`return agent('list files', { schema: ${schema} })`) });
    await runtime.approve({ runId });
    const status = await finished(runId);
    expect(agents.started[0]).toContain('Answer with only a JSON value');
    expect(agents.followUps).toEqual(['Your answer does not match the schema: the answer is not JSON. Answer again with only the JSON value.']);
    expect(await act('workflow.result', { runId })).toMatchObject({ result: { files: ['a.ts'] } });
    expect(status.state).toBe('completed');
  });

  it('resumes a failed run and reuses the agents that completed', async () => {
    const agents = fakeAgentSessions({ answer: (prompt, attempt) => (prompt === 'two' && attempt === 1 ? null : `done: ${prompt}`) });
    const { runtime, act, finished } = await setup(agents);
    const body = "const one = await agent('one')\nconst two = await agent('two')\nif (two === null) throw new Error('two failed')\nreturn [one, two]";
    const { runId } = await act('workflow.run', { script: script(body) });
    await runtime.approve({ runId });
    expect((await finished(runId)).state).toBe('failed');
    expect(agents.reports[0].body.text).toContain('two failed');

    await act('workflow.resume', { runId });
    await waitFor(() => agents.reports.length === 2);
    const status = await act('workflow.status', { runId });
    expect(status.state).toBe('completed');
    expect(agents.started).toEqual(['one', 'two', 'two']);
    expect(status.agents.map((agent) => [agent.label, Boolean(agent.replayed)])).toEqual([['one', true], ['two', false]]);
  });

  it('stops a run: running agents are interrupted and the report does not wake the session', async () => {
    const agents = fakeAgentSessions({ hang: ['slow'] });
    const { runtime, act, finished } = await setup(agents);
    const { runId } = await act('workflow.run', { script: script("return parallel([() => agent('slow 1'), () => agent('slow 2')])") });
    await runtime.approve({ runId });
    await waitFor(async () => (await act('workflow.status', { runId })).agents.filter((agent) => agent.state === 'running').length === 2);

    await runtime.stop({ runId });
    const status = await finished(runId);

    expect(status.state).toBe('stopped');
    expect(status.agents.map((agent) => agent.state)).toEqual(['stopped', 'stopped']);
    expect(agents.interrupted.sort()).toEqual(['ses_agent1', 'ses_agent2']);
    expect(agents.reports[0].body.resume).toBe(false);
  });

  it('honours a stop that arrives right after the approval', async () => {
    const agents = fakeAgentSessions();
    const { runtime, act, finished } = await setup(agents);
    const { runId } = await act('workflow.run', { script: script("return agent('x')") });
    await runtime.approve({ runId });
    await runtime.stop({ runId });
    expect((await finished(runId)).state).toBe('stopped');
  });

  it('resumes only a failed or stopped run', async () => {
    const agents = fakeAgentSessions();
    const { runtime, act, finished } = await setup(agents);
    const { runId } = await act('workflow.run', { script: script("return agent('x')") });
    await runtime.approve({ runId });
    await finished(runId);
    await expect(act('workflow.resume', { runId })).rejects.toThrow(/only a failed or stopped run resumes/);
  });

  it('keeps answers an attempt did not reach for the next attempt', async () => {
    // Attempt 1: A fails, B and C complete, the script then fails on A.
    // Attempt 2: A answers "stop" and the script fails before asking B or C,
    // whose answers must still be there for the attempt after it.
    const agents = fakeAgentSessions({ answer: (prompt, attempt) => (prompt === 'A' ? (attempt === 1 ? null : 'stop') : `done: ${prompt}`) });
    const { runtime, act } = await setup(agents);
    const body = "const a = await agent('A')\nif (a === 'stop') throw new Error('early')\nconst b = await agent('B')\nconst c = await agent('C')\nif (a === null) throw new Error('A failed')\nreturn [a, b, c]";
    const { runId } = await act('workflow.run', { script: script(body) });
    await runtime.approve({ runId });
    await waitFor(() => agents.reports.length === 1);
    await act('workflow.resume', { runId });
    await waitFor(() => agents.reports.length === 2);

    const status = await act('workflow.status', { runId });
    expect(status).toMatchObject({ state: 'failed', error: 'early' });
    expect(status.agents.filter((agent) => agent.state === 'completed').map((agent) => agent.label).sort()).toEqual(['A', 'B', 'C']);
  });

  it('records a decline without waking the session', async () => {
    const agents = fakeAgentSessions();
    const { runtime, act } = await setup(agents);
    const { runId } = await act('workflow.run', { script: script("return agent('x')") });
    await runtime.decline({ runId });
    expect(agents.started).toEqual([]);
    expect(agents.reports[0].body).toMatchObject({ resume: false, metadata: { state: 'declined' } });
    await expect(runtime.approve({ runId })).rejects.toThrow(/declined, not waiting/);
  });

  it('refuses a bad script before anything runs, and another session reading a run', async () => {
    const agents = fakeAgentSessions();
    const { runtime, act } = await setup(agents);
    await expect(act('workflow.run', { script: 'return 1' })).rejects.toThrow(/must start with export const meta/);
    const { runId } = await act('workflow.run', { script: script("return agent('x')") });
    await expect(runtime.executeAction('workflow.status', { runId }, { sessionId: 'ses_other', directory: '/tmp' })).rejects.toThrow(/belongs to another session/);
  });

  it('saves a workflow and runs it by name', async () => {
    const agents = fakeAgentSessions();
    const { act, dataDir } = await setup(agents);
    const saved = await act('workflow.save', { script: script("return agent('x')") });
    expect(saved.path).toBe(path.join(dataDir, '.openchamber', 'workflows', 'test-flow.js'));
    await expect(act('workflow.save', { script: script("return agent('x')") })).rejects.toThrow(/exists/);
    expect(await act('workflow.list')).toMatchObject({ workflows: [{ name: 'test-flow', description: 'A test' }] });
    expect(await act('workflow.run', { name: 'test-flow' })).toMatchObject({ state: 'awaiting-approval', name: 'test-flow' });
  });

  it('marks a run that was going when the server stopped, and reports it once OpenCode answers', async () => {
    const agents = fakeAgentSessions({ hang: ['slow'] });
    const first = await setup(agents);
    const { runId } = await first.act('workflow.run', { script: script("return agent('slow')") });
    await first.runtime.approve({ runId });
    await waitFor(async () => (await first.act('workflow.status', { runId })).agents.length === 1);
    await first.store.flush();

    // A second runtime over the same directory: the first one's worker is gone.
    const store = createWorkflowRunStore({ fsPromises: fs, path, dataDir: first.dataDir });
    const restarted = createWorkflowRuntime({ store, agentSessions: agents, postSynthetic: async (sessionId, body) => agents.reports.push({ sessionId, body }), fsPromises: fs, path, sleep: async () => {} });
    await restarted.start();
    const status = await restarted.executeAction('workflow.status', { runId }, { sessionId: 'ses_parent', directory: first.dataDir });
    expect(status).toMatchObject({ state: 'stopped', error: 'OpenChamber restarted while the workflow ran.' });
    await restarted.deliverPending();
    expect(agents.reports.at(-1).body.metadata).toMatchObject({ runId, state: 'stopped' });

    // Let the first runtime wind down before its directory goes.
    first.runtime.shutdown();
    await waitFor(() => agents.reports.filter((report) => report.body.metadata.runId === runId).length === 2);
    await first.store.flush();
  });
});
