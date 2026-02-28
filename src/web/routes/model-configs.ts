import { Router } from 'express';
import type { Eta } from 'eta';
import type { AppDeps } from '../app.js';
import { ModelConfigStore } from '../../db/model-config-store.js';
import type { ModelProvider } from '../../model-config/types.js';

const VALID_PROVIDERS = new Set<string>(['max', 'anthropic', 'foundry', 'local', 'custom']);

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

      store.createConfig({
        name,
        provider: provider as ModelProvider,
        ...(apiKey !== undefined ? { apiKey } : {}),
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        ...(modelId !== undefined ? { modelId } : {}),
        ...(foundryResource !== undefined ? { foundryResource } : {}),
        ...(extraEnv !== undefined ? { extraEnv } : {}),
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

  return router;
}
