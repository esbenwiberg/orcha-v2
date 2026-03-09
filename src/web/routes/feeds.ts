import { Router } from 'express';
import type { Eta } from 'eta';
import type Database from 'better-sqlite3';
import { GlobalSettingsStore } from '../../db/global-settings-store.js';

const DB_KEY = 'feeds.devops';

export interface DevOpsFeedConfig {
  org: string;
  project: string;
  pat: string;
  feeds: string[];
}

export function loadFeedConfig(store: GlobalSettingsStore): DevOpsFeedConfig | undefined {
  const raw = store.get(DB_KEY);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as DevOpsFeedConfig;
    if (!parsed.org || !parsed.feeds || parsed.feeds.length === 0) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function createFeedsRouter(eta: Eta, db: Database.Database): Router {
  const router = Router();
  const store = new GlobalSettingsStore(db);

  // GET /api/feeds — render feeds settings panel
  router.get('/feeds', (_req, res, next) => {
    try {
      const config = loadFeedConfig(store);
      const html = eta.render('partials/feeds-panel', {
        org: config?.org ?? '',
        project: config?.project ?? '',
        pat: config?.pat ?? '',
        feeds: config?.feeds?.join(', ') ?? '',
        saved: false,
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/feeds — save feed config
  router.post('/feeds', (req, res, next) => {
    try {
      const org = (typeof req.body['org'] === 'string' ? req.body['org'] : '').trim();
      const project = (typeof req.body['project'] === 'string' ? req.body['project'] : '').trim();
      const pat = (typeof req.body['pat'] === 'string' ? req.body['pat'] : '').trim();
      const feedsRaw = (typeof req.body['feeds'] === 'string' ? req.body['feeds'] : '').trim();
      const feeds = feedsRaw.split(',').map((s) => s.trim()).filter(Boolean);

      if (org && feeds.length > 0 && pat) {
        const config: DevOpsFeedConfig = { org, project, pat, feeds };
        store.set(DB_KEY, JSON.stringify(config));
      } else if (!org && feeds.length === 0 && !pat) {
        // Clear config if all fields are empty
        store.delete(DB_KEY);
      }

      const config = loadFeedConfig(store);
      const html = eta.render('partials/feeds-panel', {
        org: config?.org ?? org,
        project: config?.project ?? project,
        pat: config?.pat ?? pat,
        feeds: config?.feeds?.join(', ') ?? feedsRaw,
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
