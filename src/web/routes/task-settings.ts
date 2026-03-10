import { Router } from 'express';
import type { Eta } from 'eta';
import type Database from 'better-sqlite3';
import { GlobalSettingsStore } from '../../db/global-settings-store.js';

const KEY = 'max_concurrent_tasks';
const DEFAULT_MAX = 1;
const ABSOLUTE_MAX = 10;

export function createTaskSettingsRouter(eta: Eta, db: Database.Database): Router {
  const router = Router();
  const store = new GlobalSettingsStore(db);

  function getCurrentMax(): number {
    const raw = store.get(KEY);
    if (!raw) return DEFAULT_MAX;
    const val = parseInt(raw, 10);
    return Number.isFinite(val) && val >= 1 ? Math.min(val, ABSOLUTE_MAX) : DEFAULT_MAX;
  }

  function renderPanel(res: import('express').Response): void {
    const html = eta.render('partials/task-settings-panel', {
      maxConcurrent: getCurrentMax(),
      absoluteMax: ABSOLUTE_MAX,
    });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(html);
  }

  // GET /api/task-settings — render panel
  router.get('/task-settings', (_req, res, next) => {
    try {
      renderPanel(res);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/task-settings/max-concurrent — save value
  router.post('/task-settings/max-concurrent', (req, res, next) => {
    try {
      const raw = ((req.body as Record<string, string>)['maxConcurrent'] ?? '').trim();
      const val = parseInt(raw, 10);
      if (!Number.isFinite(val) || val < 1 || val > ABSOLUTE_MAX) {
        res.status(422).send(`<div class="badge badge-error">Must be 1–${ABSOLUTE_MAX}</div>`);
        return;
      }
      store.set(KEY, String(val));
      renderPanel(res);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
