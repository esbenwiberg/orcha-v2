import { Router } from 'express';
import type { Eta } from 'eta';
import type { AppDeps } from '../app.js';
import { PresetStore } from '../../db/preset-store.js';
import { RepoStore } from '../../db/repo-store.js';

export function createPresetsRouter(eta: Eta, deps: AppDeps): Router {
  const router = Router();
  const store = new PresetStore(deps.db);
  const repoStore = new RepoStore(deps.db);

  // GET /api/presets — render the full preset list partial (with repo names resolved)
  router.get('/presets', (_req, res, next) => {
    try {
      const presets = store.listPresets();
      const repos = repoStore.listRepos();
      const repoMap = new Map(repos.map((r) => [r.id, r.displayName]));
      const presetsWithRepoName = presets.map((p) => ({
        ...p,
        repoName: p.repoId ? (repoMap.get(p.repoId) ?? null) : null,
      }));
      const html = eta.render('partials/preset-list', { presets: presetsWithRepoName });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/presets/save-form — render the save-preset form partial
  router.get('/presets/save-form', (_req, res, next) => {
    try {
      const repos = repoStore.listRepos();
      const html = eta.render('partials/save-preset-form', { repos });
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
      const repoId = (typeof req.body['repoId'] === 'string' ? req.body['repoId'] : '').trim();

      const errors: string[] = [];

      if (name.length === 0) {
        errors.push('Preset name is required.');
      } else if (name.length > 64) {
        errors.push('Preset name must be 64 characters or fewer.');
      }

      if (errors.length > 0) {
        const repos = repoStore.listRepos();
        const formHtml = eta.render('partials/save-preset-form', { name, branch, prompt, repoId, repos });
        const html = eta.render('partials/form-error', { errors, formHtml });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(422).send(html);
        return; // error rendered in form panel slot
      }

      store.createPreset({ name, branch, prompt, repoId });

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send('');
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

      const repos = repoStore.listRepos();
      const html = eta.render('partials/new-session-form', {
        branch: preset.branch,
        prompt: preset.prompt,
        repoId: preset.repoId,
        repos,
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
