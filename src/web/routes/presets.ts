import { Router } from 'express';
import type { Eta } from 'eta';
import type { AppDeps } from '../app.js';
import { PresetStore } from '../../db/preset-store.js';

export function createPresetsRouter(eta: Eta, deps: AppDeps): Router {
  const router = Router();
  const store = new PresetStore(deps.db);

  // GET /api/presets — render the full preset list partial
  router.get('/presets', (_req, res, next) => {
    try {
      const presets = store.listPresets();
      const html = eta.render('partials/preset-list', { presets });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/presets/save-form — render the save-preset form partial
  router.get('/presets/save-form', (_req, res, next) => {
    try {
      const html = eta.render('partials/save-preset-form', {});
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/presets — create a new preset from HTMX form submission
  router.post('/presets', (req, res, next) => {
    try {
      const name = (typeof req.body['name'] === 'string' ? req.body['name'] : '').trim();
      const branch = (typeof req.body['branch'] === 'string' ? req.body['branch'] : '').trim();
      const prompt = (typeof req.body['prompt'] === 'string' ? req.body['prompt'] : '').trim();
      const basePath = (typeof req.body['basePath'] === 'string' ? req.body['basePath'] : '').trim();

      const errors: string[] = [];

      if (name.length === 0) {
        errors.push('Preset name is required.');
      } else if (name.length > 64) {
        errors.push('Preset name must be 64 characters or fewer.');
      }

      if (errors.length > 0) {
        const formHtml = eta.render('partials/save-preset-form', { name, branch, prompt, basePath });
        const html = eta.render('partials/form-error', { errors, formHtml });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(422).send(html);
        return;
      }

      store.createPreset({ name, branch, prompt, basePath });

      const presets = store.listPresets();
      const html = eta.render('partials/preset-list', { presets });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/presets/:id/load — load a preset and pre-fill the new-session form
  router.get('/presets/:id/load', (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      const preset = store.getPreset(id);

      if (preset === undefined) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(404).send('<div class="badge badge--failed">Preset not found</div>');
        return;
      }

      const html = eta.render('partials/new-session-form', {
        branch: preset.branch,
        prompt: preset.prompt,
        basePath: preset.basePath,
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/presets/:id — delete a preset; return empty span to replace the list item
  router.delete('/presets/:id', (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      store.deletePreset(id);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send('<span></span>');
    } catch (err) {
      next(err);
    }
  });

  return router;
}
