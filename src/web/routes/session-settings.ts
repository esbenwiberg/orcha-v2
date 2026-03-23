import { Router } from 'express';
import type { Eta } from 'eta';
import type Database from 'better-sqlite3';
import { GlobalSettingsStore } from '../../db/global-settings-store.js';
import type { SessionManager } from '../../terminal/session-manager.js';

const KEY = 'max_concurrent_sessions';
const ABSOLUTE_MAX = 10;

export function createSessionSettingsRouter(
  eta: Eta,
  db: Database.Database,
  sessionEngine: SessionManager,
): Router {
  const router = Router();
  const store = new GlobalSettingsStore(db);

  // On startup, sync DB value → SessionManager (DB wins over env var).
  const dbVal = store.get(KEY);
  if (dbVal) {
    const parsed = parseInt(dbVal, 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
      sessionEngine.maxSessions = Math.min(parsed, ABSOLUTE_MAX);
    }
  }

  function getCurrentMax(): number {
    return sessionEngine.maxSessions;
  }

  function renderPanel(res: import('express').Response): void {
    const html = eta.render('partials/session-settings-panel', {
      maxConcurrent: getCurrentMax(),
      absoluteMax: ABSOLUTE_MAX,
    });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(html);
  }

  // GET /api/session-settings — render panel
  router.get('/session-settings', (_req, res, next) => {
    try {
      renderPanel(res);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/session-settings/max-concurrent — save value
  router.post('/session-settings/max-concurrent', (req, res, next) => {
    try {
      const raw = ((req.body as Record<string, string>)['maxConcurrent'] ?? '').trim();
      const val = parseInt(raw, 10);
      if (!Number.isFinite(val) || val < 1 || val > ABSOLUTE_MAX) {
        res.status(422).send(`<div class="badge badge-error">Must be 1–${ABSOLUTE_MAX}</div>`);
        return;
      }
      store.set(KEY, String(val));
      sessionEngine.maxSessions = val;
      renderPanel(res);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
