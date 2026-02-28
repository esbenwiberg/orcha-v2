import { Router } from 'express';
import type { Eta } from 'eta';
import type { AppDeps } from '../app.js';
import { PresetStore } from '../../db/preset-store.js';
import { RepoStore } from '../../db/repo-store.js';
import { CredentialStore } from '../../db/credential-store.js';

export function createPresetsRouter(eta: Eta, deps: AppDeps): Router {
  const router = Router();
  const store = new PresetStore(deps.db);
  const repoStore = new RepoStore(deps.db);
  const credStore = new CredentialStore(deps.db);

  // GET /api/presets — render the full preset list partial
  router.get('/presets', (_req, res, next) => {
    try {
      const presets = store.listPresets();
      const repos = repoStore.listRepos();
      const profiles = credStore.listProfiles();
      const repoMap = new Map(repos.map((r) => [r.id, r.displayName]));
      const profileMap = new Map(profiles.map((p) => [p.id, p.name]));
      const presetsEnriched = presets.map((p) => ({
        ...p,
        repoName: p.repoId ? (repoMap.get(p.repoId) ?? null) : null,
        credentialProfileName: p.credentialProfileId
          ? (profileMap.get(p.credentialProfileId) ?? null)
          : null,
      }));
      const html = eta.render('partials/preset-list', { presets: presetsEnriched });
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
      const credentialProfiles = credStore.listProfiles();
      const html = eta.render('partials/save-preset-form', { repos, credentialProfiles });
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
      const repoId = (typeof req.body['repoId'] === 'string' ? req.body['repoId'] : '').trim();
      const credentialProfileId = (
        typeof req.body['credentialProfileId'] === 'string' ? req.body['credentialProfileId'] : ''
      ).trim();

      const errors: string[] = [];

      if (name.length === 0) {
        errors.push('Preset name is required.');
      } else if (name.length > 64) {
        errors.push('Preset name must be 64 characters or fewer.');
      }

      if (errors.length > 0) {
        const repos = repoStore.listRepos();
        const credentialProfiles = credStore.listProfiles();
        const formHtml = eta.render('partials/save-preset-form', {
          name,
          repoId,
          credentialProfileId,
          repos,
          credentialProfiles,
        });
        const html = eta.render('partials/form-error', { errors, formHtml });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(422).send(html);
        return;
      }

      store.createPreset({ name, repoId, credentialProfileId });

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('HX-Trigger', 'close-panel');
      res.setHeader('HX-Trigger-After-Swap', 'refresh-preset-list');
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
      const credentialProfiles = credStore.listProfiles();
      const html = eta.render('partials/new-session-form', {
        repoId: preset.repoId,
        credentialProfileId: preset.credentialProfileId,
        repos,
        credentialProfiles,
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
