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
      const body = req.body as Record<string, string>;
      const name = (body['name'] ?? '').trim();
      const provider = (body['provider'] ?? '').trim();

      if (!name) {
        res.status(422).send('<div class="badge badge--failed">Name is required</div>');
        return;
      }
      if (!VALID_PROVIDERS.has(provider)) {
        res.status(422).send('<div class="badge badge--failed">Invalid provider</div>');
        return;
      }

      const apiKey = (body['apiKey'] ?? '').trim() || undefined;
      const baseUrl = (body['baseUrl'] ?? '').trim() || undefined;
      const modelId = (body['modelId'] ?? '').trim() || undefined;
      const foundryResource = (body['foundryResource'] ?? '').trim() || undefined;

      // Parse custom env vars (key=value per line)
      let extraEnv: Record<string, string> | undefined;
      const extraEnvRaw = (body['extraEnv'] ?? '').trim();
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
