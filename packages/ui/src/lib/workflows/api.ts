import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';
import { workflowRunListSchema, type WorkflowRun } from './model';

const errorSchema = z.object({ error: z.string().min(1) }).catch({ error: '' });

export type WorkflowRunAction = 'approve' | 'decline' | 'stop' | 'resume';

const failure = async (response: Response, fallback: string): Promise<Error> => {
  const payload = errorSchema.parse(await response.json().catch(() => null));
  return new Error(payload.error || `${fallback} (${response.status})`);
};

/** The workflow runs a session proposed, oldest first. Throws when the server cannot answer. */
export async function fetchWorkflowRuns(sessionId: string): Promise<WorkflowRun[]> {
  const response = await runtimeFetch('/api/openchamber/workflows', { query: { sessionId } });
  if (!response.ok) throw await failure(response, 'Could not read workflow runs');
  return workflowRunListSchema.parse(await response.json()).runs;
}

/** The user's approve, decline, stop or resume; the run's new state arrives as an event. */
export async function sendWorkflowRunAction(runId: string, action: WorkflowRunAction): Promise<void> {
  const response = await runtimeFetch(`/api/openchamber/workflows/${encodeURIComponent(runId)}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) throw await failure(response, 'The workflow did not accept the action');
}
