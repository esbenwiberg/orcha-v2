import { Router } from 'express';
import type { Eta } from 'eta';
import { readSettings, writeSettings, enqueueWrite } from './claude-settings-io.js';

export function createClaudePermissionsRouter(eta: Eta): Router {
  const router = Router();

  // GET /api/claude-permissions — render the permissions panel partial
  router.get('/claude-permissions', (_req, res, next) => {
    try {
      const settings = readSettings();
      const allow = settings.permissions?.allow ?? [];
      const deny = settings.permissions?.deny ?? [];
      const html = eta.render('partials/claude-permissions-panel', { allow, deny });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/claude-permissions/allow — add an allow rule
  router.post('/claude-permissions/allow', async (req, res, next) => {
    try {
      const rule = (typeof req.body['rule'] === 'string' ? req.body['rule'] : '').trim();
      if (!rule) {
        res.status(422).send('<div class="badge badge--failed">Rule is required</div>');
        return;
      }

      await enqueueWrite(() => {
        const settings = readSettings();
        const allow = settings.permissions?.allow ?? [];
        if (!allow.includes(rule)) {
          settings.permissions = {
            allow: [...allow, rule],
            deny: settings.permissions?.deny ?? [],
          };
          writeSettings(settings);
        }
      });

      const settings = readSettings();
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
        const settings = readSettings();
        settings.permissions = {
          allow: (settings.permissions?.allow ?? []).filter((r) => r !== rule),
          deny: settings.permissions?.deny ?? [],
        };
        writeSettings(settings);
      });

      const settings = readSettings();
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

  // POST /api/claude-permissions/deny — add a deny rule
  router.post('/claude-permissions/deny', async (req, res, next) => {
    try {
      const rule = (typeof req.body['rule'] === 'string' ? req.body['rule'] : '').trim();
      if (!rule) {
        res.status(422).send('<div class="badge badge--failed">Rule is required</div>');
        return;
      }

      await enqueueWrite(() => {
        const settings = readSettings();
        const deny = settings.permissions?.deny ?? [];
        if (!deny.includes(rule)) {
          settings.permissions = {
            allow: settings.permissions?.allow ?? [],
            deny: [...deny, rule],
          };
          writeSettings(settings);
        }
      });

      const settings = readSettings();
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
        const settings = readSettings();
        settings.permissions = {
          allow: settings.permissions?.allow ?? [],
          deny: (settings.permissions?.deny ?? []).filter((r) => r !== rule),
        };
        writeSettings(settings);
      });

      const settings = readSettings();
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
