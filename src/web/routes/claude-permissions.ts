import { Router } from 'express';
import type { Eta } from 'eta';
import type Database from 'better-sqlite3';
import { GlobalSettingsStore } from '../../db/global-settings-store.js';
import { readSettingsFromDb, writeSettingsToDb, enqueueWrite } from './claude-settings-db.js';

/** Split a textarea value into trimmed, non-empty rules (one per line). */
function parseRules(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export function createClaudePermissionsRouter(eta: Eta, db: Database.Database): Router {
  const router = Router();
  const settingsStore = new GlobalSettingsStore(db);

  // GET /api/claude-permissions — render the permissions panel partial
  router.get('/claude-permissions', (_req, res, next) => {
    try {
      const settings = readSettingsFromDb(settingsStore);
      const allow = settings.permissions?.allow ?? [];
      const deny = settings.permissions?.deny ?? [];
      const html = eta.render('partials/claude-permissions-panel', { allow, deny });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/claude-permissions/allow — add allow rule(s), one per line
  router.post('/claude-permissions/allow', async (req, res, next) => {
    try {
      const rules = parseRules(req.body['rules']);
      if (rules.length === 0) {
        res.status(422).send('<div class="badge badge-error">At least one rule is required</div>');
        return;
      }

      await enqueueWrite(() => {
        const settings = readSettingsFromDb(settingsStore);
        const allow = settings.permissions?.allow ?? [];
        const newRules = rules.filter((r) => !allow.includes(r));
        if (newRules.length > 0) {
          settings.permissions = {
            allow: [...allow, ...newRules],
            deny: settings.permissions?.deny ?? [],
          };
          writeSettingsToDb(settingsStore, settings);
        }
      });

      const settings = readSettingsFromDb(settingsStore);
      const html = eta.render('partials/claude-permissions-panel', {
        allow: settings.permissions?.allow ?? [],
        deny: settings.permissions?.deny ?? [],
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/claude-permissions/allow/:encoded — remove an allow rule
  router.delete('/claude-permissions/allow/:encoded', async (req, res, next) => {
    try {
      const rule = decodeURIComponent(req.params['encoded'] ?? '');

      await enqueueWrite(() => {
        const settings = readSettingsFromDb(settingsStore);
        settings.permissions = {
          allow: (settings.permissions?.allow ?? []).filter((r) => r !== rule),
          deny: settings.permissions?.deny ?? [],
        };
        writeSettingsToDb(settingsStore, settings);
      });

      const settings = readSettingsFromDb(settingsStore);
      const html = eta.render('partials/claude-permissions-panel', {
        allow: settings.permissions?.allow ?? [],
        deny: settings.permissions?.deny ?? [],
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/claude-permissions/deny — add deny rule(s), one per line
  router.post('/claude-permissions/deny', async (req, res, next) => {
    try {
      const rules = parseRules(req.body['rules']);
      if (rules.length === 0) {
        res.status(422).send('<div class="badge badge-error">At least one rule is required</div>');
        return;
      }

      await enqueueWrite(() => {
        const settings = readSettingsFromDb(settingsStore);
        const deny = settings.permissions?.deny ?? [];
        const newRules = rules.filter((r) => !deny.includes(r));
        if (newRules.length > 0) {
          settings.permissions = {
            allow: settings.permissions?.allow ?? [],
            deny: [...deny, ...newRules],
          };
          writeSettingsToDb(settingsStore, settings);
        }
      });

      const settings = readSettingsFromDb(settingsStore);
      const html = eta.render('partials/claude-permissions-panel', {
        allow: settings.permissions?.allow ?? [],
        deny: settings.permissions?.deny ?? [],
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/claude-permissions/deny/:encoded — remove a deny rule
  router.delete('/claude-permissions/deny/:encoded', async (req, res, next) => {
    try {
      const rule = decodeURIComponent(req.params['encoded'] ?? '');

      await enqueueWrite(() => {
        const settings = readSettingsFromDb(settingsStore);
        settings.permissions = {
          allow: settings.permissions?.allow ?? [],
          deny: (settings.permissions?.deny ?? []).filter((r) => r !== rule),
        };
        writeSettingsToDb(settingsStore, settings);
      });

      const settings = readSettingsFromDb(settingsStore);
      const html = eta.render('partials/claude-permissions-panel', {
        allow: settings.permissions?.allow ?? [],
        deny: settings.permissions?.deny ?? [],
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
