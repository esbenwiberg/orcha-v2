import { Router } from 'express';
import type { Eta } from 'eta';
import type { AppDeps } from '../app.js';
import { GlobalSettingsStore } from '../../db/global-settings-store.js';

export function createGitIdentityRouter(eta: Eta, deps: AppDeps): Router {
  const router = Router();
  const store = new GlobalSettingsStore(deps.db);

  // GET /api/git-identity — render the git identity panel
  router.get('/git-identity', (_req, res, next) => {
    try {
      const html = eta.render('partials/git-identity-panel', {
        name: store.get('git.user.name') ?? '',
        email: store.get('git.user.email') ?? '',
        saved: false,
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/git-identity — save git identity settings
  router.post('/git-identity', (req, res, next) => {
    try {
      const name = (typeof req.body['name'] === 'string' ? req.body['name'] : '').trim();
      const email = (typeof req.body['email'] === 'string' ? req.body['email'] : '').trim();

      if (name) store.set('git.user.name', name);
      if (email) store.set('git.user.email', email);

      const html = eta.render('partials/git-identity-panel', {
        name,
        email,
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
