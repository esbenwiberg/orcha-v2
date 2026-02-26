import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { AppError, createAppError } from '../errors.js';
import { validateBody } from '../middleware/validate.js';
import { sanitisePath, sanitiseBranchName } from '../utils/sanitise.js';
import { SessionError } from '../../terminal/session-manager.js';

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const CreateSessionSchema = z.object({
  name: z.string().min(1).max(100),
  repoPath: z.string().min(1),
  branch: z.string().optional(),
  prompt: z.string().optional(),
});

const SendInputSchema = z.object({
  text: z.string().min(1).max(4096),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_ID_RE = /^[a-z0-9-]{1,64}$/;

function validateSessionId(id: string): void {
  if (!SESSION_ID_RE.test(id)) {
    throw createAppError(400, 'Invalid session id', 'INVALID_INPUT');
  }
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createApiRouter(deps: AppDeps): Router {
  const router = Router();

  // GET /api/sessions — list all active sessions
  router.get('/sessions', (_req, res, next) => {
    try {
      const sessions = deps.sessionEngine.listSessions();
      res.status(200).json({ data: sessions });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/sessions — create a new session
  router.post('/sessions', validateBody(CreateSessionSchema), async (req, res, next) => {
    try {
      const { name, repoPath, branch, prompt } = req.body as z.infer<typeof CreateSessionSchema>;

      // Sanitise inputs
      const safePath = sanitisePath(repoPath);
      const safeBranch = branch !== undefined ? sanitiseBranchName(branch) : 'main';

      const env: Record<string, string> = {
        ORCHA_SESSION_NAME: name,
        ORCHA_REPO_PATH: safePath,
      };
      if (prompt !== undefined) {
        env['ORCHA_PROMPT'] = prompt;
      }

      const session = await deps.sessionEngine.createSession({
        branch: safeBranch,
        command: 'bash',
        env,
      });

      res.status(201).json({ data: session });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/sessions/:id — stop and remove a session
  router.delete('/sessions/:id', async (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      validateSessionId(id);

      await deps.sessionEngine.stopSession(id);
      res.status(204).send();
    } catch (err) {
      if (err instanceof SessionError && err.code === 'NOT_FOUND') {
        next(new AppError(404, err.message, 'NOT_FOUND'));
        return;
      }
      next(err);
    }
  });

  // POST /api/sessions/:id/send — send input to a session's terminal
  router.post('/sessions/:id/send', validateBody(SendInputSchema), async (req, res, next) => {
    try {
      const id = String(req.params['id'] ?? '');
      validateSessionId(id);

      const { text } = req.body as z.infer<typeof SendInputSchema>;

      // Reject null bytes
      if (text.includes('\x00')) {
        throw createAppError(400, 'Input contains invalid characters', 'INVALID_INPUT');
      }

      const session = deps.sessionEngine.getSession(id);
      if (session === undefined) {
        throw new AppError(404, `Session '${id}' not found`, 'NOT_FOUND');
      }

      session.terminal.write(text);
      res.status(200).json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/instances — list registered instances
  router.get('/instances', (_req, res, next) => {
    try {
      const instances = deps.db
        .prepare('SELECT * FROM instances ORDER BY registered_at DESC')
        .all();
      res.status(200).json({ data: instances });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
