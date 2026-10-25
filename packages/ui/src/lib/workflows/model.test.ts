import { describe, expect, test } from 'bun:test';

import { groupWorkflowAgentsByPhase, workflowRunSchema, type WorkflowAgent, type WorkflowRun } from './model';
import { readWorkflowReport } from './report';
import type { SyntheticMessage } from '@/lib/opencode/model';
import { isBackgroundReportEntry } from '@/components/chat/lib/timelineRoles';

const agent = (key: string, phase: string | null, state: WorkflowAgent['state']): WorkflowAgent => ({ key, label: key, phase, state });

const run = (agents: WorkflowAgent[], phases: string[]): WorkflowRun => workflowRunSchema.parse({
  id: 'wf_one',
  parentSessionId: 'ses_parent',
  directory: '/repo',
  name: 'audit-routes',
  description: 'Audit every route',
  state: 'running',
  attempt: 1,
  createdAt: 1,
  currentPhase: 'Audit',
  phases,
  agents,
  logs: [],
});

describe('groupWorkflowAgentsByPhase', () => {
  test('keeps the planned order, adds phases named on the way and agents outside a phase last', () => {
    const groups = groupWorkflowAgentsByPhase(run([
      agent('a', 'Audit', 'completed'),
      agent('b', 'Audit', 'running'),
      agent('c', null, 'failed'),
      agent('d', 'Extra', 'completed'),
    ], ['Find', 'Audit']));

    expect(groups.map((group) => [group.title, group.agents.length, group.done, group.running, group.failed])).toEqual([
      ['Find', 0, 0, 0, 0],
      ['Audit', 2, 1, 1, 0],
      [null, 1, 0, 0, 1],
      ['Extra', 1, 1, 0, 0],
    ]);
  });
});

describe('readWorkflowReport', () => {
  // The shape `web/server/lib/workflows` admits into the session that proposed the run.
  const message = (overrides: Partial<SyntheticMessage> = {}): SyntheticMessage => ({
    id: 'msg_report',
    sessionID: 'ses_parent',
    role: 'synthetic',
    time: { created: 5 },
    text: '<openchamber-workflow runId="wf_one" name="audit-routes" state="completed">\nAgents: 2 completed.\n</openchamber-workflow>',
    description: 'audit-routes',
    metadata: { source: 'openchamber-workflow', runId: 'wf_one', name: 'audit-routes', state: 'completed' },
    ...overrides,
  });

  test('reads the run and the report without its envelope', () => {
    expect(readWorkflowReport(message())).toEqual({ runId: 'wf_one', name: 'audit-routes', state: 'completed', output: 'Agents: 2 completed.' });
    // It opens a turn of its own, like a dispatched session's result.
    expect(isBackgroundReportEntry(message())).toBe(true);
  });

  test('ignores other synthetic messages', () => {
    expect(readWorkflowReport(message({ metadata: { source: 'openchamber-session', sessionID: 'ses_1', state: 'completed' } }))).toBeUndefined();
  });
});
