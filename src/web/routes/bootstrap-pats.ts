import { Router } from 'express';
import type { Eta } from 'eta';
import { GlobalSettingsStore } from '../../db/global-settings-store.js';
import type Database from 'better-sqlite3';

const DEVOPS_KEY = 'devops_bootstrap_pat';

export function createBootstrapPatsRouter(eta: Eta, db: Database.Database): Router {
  const router = Router();
  const store = new GlobalSettingsStore(db);

  function renderPanel(res: import('express').Response): void {
    const html = eta.render('partials/bootstrap-pats-panel', {
      devopsSet: store.has(DEVOPS_KEY),
    });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(html);
  }

  // GET /api/bootstrap-pats — render panel
  router.get('/bootstrap-pats', (_req, res, next) => {
    try {
      renderPanel(res);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/bootstrap-pats/devops — save DevOps bootstrap PAT
  router.post('/bootstrap-pats/devops', (req, res, next) => {
    try {
      const pat = ((req.body as Record<string, string>)['pat'] ?? '').trim();
      if (!pat) {
        res.status(422).send('<div class="badge badge-error">PAT is required</div>');
        return;
      }
      store.set(DEVOPS_KEY, pat);
      renderPanel(res);
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/bootstrap-pats/devops — clear DevOps bootstrap PAT
  router.delete('/bootstrap-pats/devops', (_req, res, next) => {
    try {
      store.delete(DEVOPS_KEY);
      renderPanel(res);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
