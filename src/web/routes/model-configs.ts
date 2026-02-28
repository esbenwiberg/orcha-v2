import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Router } from 'express';
import type { Eta } from 'eta';
import type { AppDeps } from '../app.js';
import { ModelConfigStore } from '../../db/model-config-store.js';
import type { ModelProvider } from '../../model-config/types.js';

const VALID_PROVIDERS = new Set<string>(['max', 'anthropic', 'foundry', 'local', 'custom']);

/** Path to the Claude OAuth credentials file on the host filesystem. */
const CLAUDE_CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');

export function createModelConfigsRouter(eta: Eta, deps: AppDeps): Router {
  const router = Router();
  const store = new ModelConfigStore(deps.db);

  // GET /api/model-configs — render list partial
  router.get('/model-configs', (_req, res, next) => {
    try {
      const configs = store.listConfigs();
      const html = eta.render('partials/model-config-list', { configs });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/model-configs/form — render create form
  router.get('/model-configs/form', (_req, res, next) => {
    try {
      const html = eta.render('partials/model-config-form', {});
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/model-configs — create a model config
  router.post('/model-configs', (req, res, next) => {
    try {
      // Some field names appear in multiple hidden sections (e.g. apiKey, baseUrl).
      // Express parses duplicate names as arrays — take the first non-empty value.
      const body = req.body as Record<string, unknown>;
      const getField = (key: string): string => {
        const v = body[key];
        if (Array.isArray(v)) return (v as string[]).find((s) => typeof s === 'string' && s.length > 0) ?? '';
        return typeof v === 'string' ? v : '';
      };
      const name = getField('name').trim();
      const provider = getField('provider').trim();

      if (!name) {
        res.status(422).send('<div class="badge badge--failed">Name is required</div>');
        return;
      }
      if (!VALID_PROVIDERS.has(provider)) {
        res.status(422).send('<div class="badge badge--failed">Invalid provider</div>');
        return;
      }

      const apiKey = getField('apiKey').trim() || undefined;
      const baseUrl = getField('baseUrl').trim() || undefined;
      const modelId = getField('modelId').trim() || undefined;
      const foundryResource = getField('foundryResource').trim() || undefined;

      // Parse custom env vars (key=value per line)
      let extraEnv: Record<string, string> | undefined;
      const extraEnvRaw = getField('extraEnv').trim();
      if (extraEnvRaw && provider === 'custom') {
        extraEnv = {};
        for (const line of extraEnvRaw.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx > 0) {
            extraEnv[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
          }
        }
      }

      // Parse credentials JSON for the max provider
      const credentialsJson = provider === 'max' ? (getField('credentialsJson').trim() || undefined) : undefined;

      store.createConfig({
        name,
        provider: provider as ModelProvider,
        ...(apiKey !== undefined ? { apiKey } : {}),
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        ...(modelId !== undefined ? { modelId } : {}),
        ...(foundryResource !== undefined ? { foundryResource } : {}),
        ...(extraEnv !== undefined ? { extraEnv } : {}),
        ...(credentialsJson !== undefined ? { credentialsJson } : {}),
      });

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('HX-Trigger', 'close-panel');
      res.setHeader('HX-Trigger-After-Swap', 'refresh-model-list');
      res.status(200).send('');
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/model-configs/:id — delete a model config
  router.delete('/model-configs/:id', (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      store.deleteConfig(id);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  // ---------------------------------------------------------------------------
  // Auth wizard routes (max provider OAuth flow)
  // ---------------------------------------------------------------------------

  // POST /api/model-configs/:id/auth/start
  // Spawns a `claude` PTY session and returns the auth panel partial.
  router.post('/model-configs/:id/auth/start', (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      const config = store.getConfig(id);
      if (config === undefined) {
        res.status(404).send('<div class="badge badge--failed">Config not found</div>');
        return;
      }

      const token = deps.authTerminalManager.startSession(id);
      const html = eta.render('partials/model-config-auth-panel', { id, token });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/model-configs/:id/auth/status?token=<token>
  // Polls for credentials. If found, saves to config and returns success element.
  router.get('/model-configs/:id/auth/status', (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      const token = typeof req.query['token'] === 'string' ? req.query['token'] : '';

      let credentialsJson: string | undefined;
      try {
        const raw = readFileSync(CLAUDE_CREDENTIALS_PATH, 'utf8');
        // Validate it looks like a credentials file
        const parsed = JSON.parse(raw) as unknown;
        if (typeof parsed === 'object' && parsed !== null && 'claudeAiOauth' in parsed) {
          credentialsJson = raw;
        }
      } catch {
        // File doesn't exist or isn't readable yet — still waiting
      }

      if (credentialsJson !== undefined) {
        // Save to config and stop the auth session
        store.updateConfig(id, { credentialsJson });
        deps.authTerminalManager.stopSession(token);

        // Return a non-polling success element
        const html =
          '<div id="auth-status-indicator" class="auth-status auth-status--success">' +
          '<span class="badge badge--running">Authenticated</span>' +
          '<p class="text-xs text-muted" style="margin-top:0.5rem">Credentials saved to config. You can close this panel.</p>' +
          '</div>';
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(200).send(html);
        return;
      }

      // Still waiting — return a polling indicator
      const html =
        `<div id="auth-status-indicator" class="auth-status"` +
        ` hx-get="/api/model-configs/${id}/auth/status?token=${token}"` +
        ` hx-trigger="every 2s"` +
        ` hx-swap="outerHTML">` +
        '<span class="badge badge--paused">Waiting for login…</span>' +
        '</div>';
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/model-configs/:id/auth/stop?token=<token>
  // Kills the auth PTY session.
  router.delete('/model-configs/:id/auth/stop', (req, res, next) => {
    try {
      const token = typeof req.query['token'] === 'string' ? req.query['token'] : '';
      deps.authTerminalManager.stopSession(token);
      res.status(200).send('');
    } catch (err) {
      next(err);
    }
  });

  return router;
}
