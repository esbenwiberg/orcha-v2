import { Router } from 'express';
import type { Eta } from 'eta';
import type { AppDeps } from '../app.js';
import { PresetStore } from '../../db/preset-store.js';
import { RepoStore } from '../../db/repo-store.js';
import { CredentialStore } from '../../db/credential-store.js';
import { ModelConfigStore } from '../../db/model-config-store.js';

export function createPresetsRouter(eta: Eta, deps: AppDeps): Router {
  const router = Router();
  const store = new PresetStore(deps.db);
  const repoStore = new RepoStore(deps.db);
  const credStore = new CredentialStore(deps.db);
  const modelConfigStore = new ModelConfigStore(deps.db);

  // GET /api/presets — render the full preset list partial
  router.get('/presets', (_req, res, next) => {
    try {
      const presets = store.listPresets();
      const repos = repoStore.listRepos();
      const profiles = credStore.listProfiles();
      const modelConfigs = modelConfigStore.listConfigs();
      const repoMap = new Map(repos.map((r) => [r.id, r.displayName]));
      const profileMap = new Map(profiles.map((p) => [p.id, p.name]));
      const modelConfigMap = new Map(modelConfigs.map((mc) => [mc.id, mc.name]));
      const presetsEnriched = presets.map((p) => ({
        ...p,
        repoName: p.repoId ? (repoMap.get(p.repoId) ?? null) : null,
        credentialProfileName: p.credentialProfileId
          ? (profileMap.get(p.credentialProfileId) ?? null)
          : null,
        modelConfigName: p.modelConfigId
          ? (modelConfigMap.get(p.modelConfigId) ?? null)
          : null,
      }));
      const html = eta.render('partials/preset-list', { presets: presetsEnriched });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/presets/picker — render preset picker for the sessions page
  router.get('/presets/picker', (_req, res, next) => {
    try {
      const presets = store.listPresets();
      const repos = repoStore.listRepos();
      const modelConfigs = modelConfigStore.listConfigs();
      const repoMap = new Map(repos.map((r) => [r.id, r.displayName]));
      const modelConfigMap = new Map(modelConfigs.map((mc) => [mc.id, mc.name]));
      const presetsEnriched = presets.map((p) => ({
        ...p,
        repoName: p.repoId ? (repoMap.get(p.repoId) ?? null) : null,
        modelConfigName: p.modelConfigId ? (modelConfigMap.get(p.modelConfigId) ?? null) : null,
      }));
      const html = eta.render('partials/preset-picker', { presets: presetsEnriched });
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
      const modelConfigs = modelConfigStore.listConfigs();
      const html = eta.render('partials/save-preset-form', { repos, credentialProfiles, modelConfigs });
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
      const modelConfigId = (
        typeof req.body['modelConfigId'] === 'string' ? req.body['modelConfigId'] : ''
      ).trim();
      const validateMode = (typeof req.body['validateMode'] === 'string' ? req.body['validateMode'] : '').trim();
      const validateBuild = (typeof req.body['validateBuild'] === 'string' ? req.body['validateBuild'] : '').trim();
      const validateStart = (typeof req.body['validateStart'] === 'string' ? req.body['validateStart'] : '').trim();
      const validateHealth = (typeof req.body['validateHealth'] === 'string' ? req.body['validateHealth'] : '').trim();
      const validateComposeFile = (typeof req.body['validateComposeFile'] === 'string' ? req.body['validateComposeFile'] : '').trim();
      const validateTimeoutRaw = typeof req.body['validateTimeout'] === 'string' ? req.body['validateTimeout'] : '';
      const validateTimeout = validateTimeoutRaw ? parseInt(validateTimeoutRaw, 10) : undefined;

      const errors: string[] = [];

      if (name.length === 0) {
        errors.push('Preset name is required.');
      } else if (name.length > 64) {
        errors.push('Preset name must be 64 characters or fewer.');
      }

      if (errors.length > 0) {
        const repos = repoStore.listRepos();
        const credentialProfiles = credStore.listProfiles();
        const modelConfigs = modelConfigStore.listConfigs();
        const formHtml = eta.render('partials/save-preset-form', {
          name,
          repoId,
          credentialProfileId,
          modelConfigId,
          validateMode,
          validateBuild,
          validateStart,
          validateHealth,
          validateComposeFile,
          validateTimeout,
          repos,
          credentialProfiles,
          modelConfigs,
        });
        const html = eta.render('partials/form-error', { errors, formHtml });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(422).send(html);
        return;
      }

      store.createPreset({
        name, repoId, credentialProfileId, modelConfigId,
        ...(validateMode ? { validateMode } : {}),
        ...(validateBuild ? { validateBuild } : {}),
        ...(validateStart ? { validateStart } : {}),
        ...(validateHealth ? { validateHealth } : {}),
        ...(validateComposeFile ? { validateComposeFile } : {}),
        ...(validateTimeout !== undefined && !isNaN(validateTimeout) ? { validateTimeout } : {}),
      });

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('HX-Trigger', 'close-panel');
      res.setHeader('HX-Trigger-After-Swap', 'refresh-preset-list');
      res.status(200).send('');
    } catch (err) {
      next(err);
    }
  });

  // GET /api/presets/:id/edit-form — render edit form with pre-populated values
  router.get('/presets/:id/edit-form', (req, res, next) => {
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
      const modelConfigs = modelConfigStore.listConfigs();
      const html = eta.render('partials/save-preset-form', {
        editId: preset.id,
        name: preset.name,
        repoId: preset.repoId,
        credentialProfileId: preset.credentialProfileId,
        modelConfigId: preset.modelConfigId,
        validateMode: preset.validateMode ?? '',
        validateBuild: preset.validateBuild ?? '',
        validateStart: preset.validateStart ?? '',
        validateHealth: preset.validateHealth ?? '',
        validateComposeFile: preset.validateComposeFile ?? '',
        validateTimeout: preset.validateTimeout,
        repos,
        credentialProfiles,
        modelConfigs,
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/presets/:id — update a preset
  router.put('/presets/:id', (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      const name = (typeof req.body['name'] === 'string' ? req.body['name'] : '').trim();
      const repoId = (typeof req.body['repoId'] === 'string' ? req.body['repoId'] : '').trim();
      const credentialProfileId = (
        typeof req.body['credentialProfileId'] === 'string' ? req.body['credentialProfileId'] : ''
      ).trim();
      const modelConfigId = (
        typeof req.body['modelConfigId'] === 'string' ? req.body['modelConfigId'] : ''
      ).trim();
      const validateMode = (typeof req.body['validateMode'] === 'string' ? req.body['validateMode'] : '').trim();
      const validateBuild = (typeof req.body['validateBuild'] === 'string' ? req.body['validateBuild'] : '').trim();
      const validateStart = (typeof req.body['validateStart'] === 'string' ? req.body['validateStart'] : '').trim();
      const validateHealth = (typeof req.body['validateHealth'] === 'string' ? req.body['validateHealth'] : '').trim();
      const validateComposeFile = (typeof req.body['validateComposeFile'] === 'string' ? req.body['validateComposeFile'] : '').trim();
      const validateTimeoutRaw = typeof req.body['validateTimeout'] === 'string' ? req.body['validateTimeout'] : '';
      const validateTimeout = validateTimeoutRaw ? parseInt(validateTimeoutRaw, 10) : undefined;

      const errors: string[] = [];

      if (name.length === 0) {
        errors.push('Preset name is required.');
      } else if (name.length > 64) {
        errors.push('Preset name must be 64 characters or fewer.');
      }

      if (errors.length > 0) {
        const repos = repoStore.listRepos();
        const credentialProfiles = credStore.listProfiles();
        const modelConfigs = modelConfigStore.listConfigs();
        const formHtml = eta.render('partials/save-preset-form', {
          editId: id,
          name,
          repoId,
          credentialProfileId,
          modelConfigId,
          validateMode,
          validateBuild,
          validateStart,
          validateHealth,
          validateComposeFile,
          validateTimeout,
          repos,
          credentialProfiles,
          modelConfigs,
        });
        const html = eta.render('partials/form-error', { errors, formHtml });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(422).send(html);
        return;
      }

      store.updatePreset(id, {
        name, repoId, credentialProfileId, modelConfigId,
        ...(validateMode ? { validateMode } : {}),
        ...(validateBuild ? { validateBuild } : {}),
        ...(validateStart ? { validateStart } : {}),
        ...(validateHealth ? { validateHealth } : {}),
        ...(validateComposeFile ? { validateComposeFile } : {}),
        ...(validateTimeout !== undefined && !isNaN(validateTimeout) ? { validateTimeout } : {}),
      });

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('HX-Trigger', 'close-panel');
      res.setHeader('HX-Trigger-After-Swap', 'refresh-preset-list');
      res.status(200).send('');
    } catch (err) {
      next(err);
    }
  });

  // GET /api/presets/:id/load — load a preset and pre-fill the new-session form
  router.get('/presets/:id/load', async (req, res, next) => {
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
      const modelConfigs = modelConfigStore.listConfigs();

      // Pre-fetch branches if the preset has a repo
      let branches: { name: string; isDefault: boolean }[] = [];
      let defaultBranch: string | undefined;
      if (preset.repoId) {
        const repo = repoStore.getRepo(preset.repoId);
        if (repo?.barePath) {
          try {
            await deps.worktreeManager.fetchBareRepo(repo.barePath);
          } catch (err) {
            console.warn(`[presets] fetchBareRepo failed for ${preset.repoId}:`, err);
          }
          try {
            const branchNames = await deps.worktreeManager.listRemoteBranches(repo.barePath);
            defaultBranch = await deps.worktreeManager.getDefaultBranch(repo.barePath);
            branches = branchNames
              .filter((b) => b !== 'HEAD')
              .map((b) => ({ name: b, isDefault: b === defaultBranch }));
          } catch (err) {
            console.warn(`[presets] branch list failed for repo ${preset.repoId}:`, err);
          }
        }
      }

      // Generate a random branch name: feature/<8 random lowercase letters>
      const randomSuffix = Array.from({ length: 8 }, () =>
        String.fromCharCode(97 + Math.floor(Math.random() * 26)),
      ).join('');
      const branch = `feature/${randomSuffix}`;

      const html = eta.render('partials/new-session-form', {
        repoId: preset.repoId,
        credentialProfileId: preset.credentialProfileId,
        modelConfigId: preset.modelConfigId,
        repos,
        credentialProfiles,
        modelConfigs,
        branches,
        defaultBranch,
        branch,
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
