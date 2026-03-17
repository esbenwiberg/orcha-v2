import { Router } from 'express';
import type { Eta } from 'eta';
import type { AppDeps } from '../app.js';
import { GlobalSettingsStore } from '../../db/global-settings-store.js';

export function createPrismSettingsRouter(eta: Eta, deps: AppDeps): Router {
  const router = Router();
  const store = new GlobalSettingsStore(deps.db);

  // GET /api/prism-settings — render the Prism config panel
  router.get('/prism-settings', (_req, res, next) => {
    try {
      const html = eta.render('partials/prism-panel', {
        url: store.get('prism.url') ?? '',
        apiKey: store.get('prism.api_key') ?? '',
        saved: false,
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/prism-settings — save Prism connection config
  router.post('/prism-settings', (req, res, next) => {
    try {
      const url = (typeof req.body['url'] === 'string' ? req.body['url'] : '').trim();
      const apiKey = (typeof req.body['apiKey'] === 'string' ? req.body['apiKey'] : '').trim();

      if (url) {
        store.set('prism.url', url);
      } else {
        store.delete('prism.url');
      }

      if (apiKey) {
        store.set('prism.api_key', apiKey);
      } else {
        store.delete('prism.api_key');
      }

      const html = eta.render('partials/prism-panel', {
        url,
        apiKey,
        saved: true,
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
