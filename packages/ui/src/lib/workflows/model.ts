import { z } from 'zod';

/**
 * A workflow run as the OpenChamber server summarizes it
 * (`packages/web/server/lib/workflows/runtime.js`, `summarizeRun`): the plan,
 * the agents with their state and session, and recent log lines. The script and
 * the agents' full answers stay on the server.
 */

const agentStateSchema = z.enum(['queued', 'running', 'completed', 'failed', 'stopped']);
const runStateSchema = z.enum(['awaiting-approval', 'running', 'completed', 'failed', 'stopped', 'declined']);

const workflowAgentSchema = z.object({
  key: z.string().min(1),
  label: z.string(),
  phase: z.string().nullable(),
  state: agentStateSchema,
  sessionId: z.string().min(1).optional(),
  replayed: z.boolean().optional(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  error: z.string().optional(),
  preview: z.string().optional(),
});

export const workflowRunSchema = z.object({
  id: z.string().min(1),
  parentSessionId: z.string().min(1),
  directory: z.string(),
  name: z.string(),
  description: z.string(),
  state: runStateSchema,
  attempt: z.number(),
  createdAt: z.number(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  currentPhase: z.string().nullable(),
  phases: z.array(z.string()),
  agents: z.array(workflowAgentSchema),
  logs: z.array(z.object({ at: z.number(), message: z.string() })),
  error: z.string().optional(),
  resultPreview: z.string().optional(),
});

export type WorkflowRun = z.infer<typeof workflowRunSchema>;
export type WorkflowRunState = WorkflowRun['state'];
export type WorkflowAgent = z.infer<typeof workflowAgentSchema>;
export type WorkflowAgentState = WorkflowAgent['state'];

export const workflowRunListSchema = z.object({ runs: z.array(workflowRunSchema) });

/** A run that is still going or still waiting for the user. */
export const isWorkflowRunOpen = (run: WorkflowRun): boolean => run.state === 'running' || run.state === 'awaiting-approval';

type WorkflowPhaseGroup = {
  title: string | null;
  agents: WorkflowAgent[];
  done: number;
  running: number;
  failed: number;
};

/**
 * The run's agents grouped by phase, in plan order: the planned phases first,
 * then any phase the script named on the way, then agents started outside a
 * phase. A planned phase nobody reached yet shows with no agents.
 */
export const groupWorkflowAgentsByPhase = (run: WorkflowRun): WorkflowPhaseGroup[] => {
  const groups = new Map<string | null, WorkflowAgent[]>();
  for (const title of run.phases) groups.set(title, []);
  for (const agent of run.agents) {
    const list = groups.get(agent.phase) ?? [];
    list.push(agent);
    groups.set(agent.phase, list);
  }
  return [...groups.entries()]
    .filter(([title, agents]) => title !== null || agents.length > 0)
    .map(([title, agents]) => ({
      title,
      agents,
      done: agents.filter((agent) => agent.state === 'completed').length,
      running: agents.filter((agent) => agent.state === 'running').length,
      failed: agents.filter((agent) => agent.state === 'failed' || agent.state === 'stopped').length,
    }));
};
