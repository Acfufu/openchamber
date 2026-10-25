import express from 'express';
import { z } from 'zod';

import { asControlError } from '../openchamber-control/error.js';

const ACTIONS = new Set(['approve', 'decline', 'stop', 'resume']);
const listQuerySchema = z.object({ sessionId: z.string().trim().min(1) });

/**
 * The user's side of workflow runs: the runs of a session for the chat and the
 * work-status panel, and the approve, decline, stop and resume buttons.
 * Registered only in builds with workflows.
 */
export const registerWorkflowRoutes = (app, runtime) => {
  app.get('/api/openchamber/workflows', async (req, res) => {
    const query = listQuerySchema.safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: 'sessionId is required' });
    try {
      return res.json({ runs: await runtime.list({ sessionId: query.data.sessionId }) });
    } catch (error) {
      const controlError = asControlError(error, 'Could not read workflow runs');
      return res.status(controlError.statusCode).json({ error: controlError.message });
    }
  });

  app.post('/api/openchamber/workflows/:runId/:action', express.json({ limit: '4kb' }), async (req, res) => {
    const { runId, action } = req.params;
    if (!ACTIONS.has(action)) return res.status(404).json({ error: `Unknown workflow action: ${action}` });
    try {
      return res.json(await runtime[action]({ runId }));
    } catch (error) {
      const controlError = asControlError(error, `Could not ${action} the workflow`);
      return res.status(controlError.statusCode).json({ error: controlError.message });
    }
  });
};
