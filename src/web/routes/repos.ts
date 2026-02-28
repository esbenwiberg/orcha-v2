import { Router } from 'express';
import type { Eta } from 'eta';
import type { AppDeps } from '../app.js';
import { RepoStore, validateRepoUrl } from '../../db/repo-store.js';

export function createReposRouter(eta: Eta, deps: AppDeps): Router {
  const router = Router();
  const store = new RepoStore(deps.db);

  // GET /api/repos — render repo list partial
  router.get('/repos', (_req, res, next) => {
    try {
      const repos = store.listRepos();
      const html = eta.render('partials/repo-list', { repos });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/repos/add-form — render add-repo form
  router.get('/repos/add-form', (_req, res, next) => {
    try {
      const html = eta.render('partials/add-repo-form', {});
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/repos — validate URL, insert repo, fire-and-forget ensureBareRepo
  router.post('/repos', (req, res, next) => {
    try {
      const url = (typeof req.body['url'] === 'string' ? req.body['url'] : '').trim();
      const gitToken = (typeof req.body['gitToken'] === 'string' ? req.body['gitToken'] : '').trim();

      const errors: string[] = [];
      const urlError = validateRepoUrl(url);
      if (urlError !== null) errors.push(urlError);

      // Check for duplicate
      if (errors.length === 0 && store.getRepoByUrl(url) !== undefined) {
        errors.push('This repository has already been added.');
      }

      if (errors.length > 0) {
        const formHtml = eta.render('partials/add-repo-form', { url });
        const html = eta.render('partials/form-error', { errors, formHtml });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(422).send(html);
        return;
      }

      const repo = store.createRepo({ url });

      // Build clone URL: inject token into URL if provided (not stored in DB)
      let cloneUrl = url;
      if (gitToken.length > 0) {
        try {
          const u = new URL(url);
          u.username = 'token';
          u.password = gitToken;
          cloneUrl = u.toString();
        } catch {
          cloneUrl = url;
        }
      }

      // Fire-and-forget: clone bare repo in background
      store.updateStatus(repo.id, 'cloning');
      deps.worktreeManager
        .ensureBareRepo(cloneUrl)
        .then((barePath) => {
          store.updateStatus(repo.id, 'ready', { barePath });
        })
        .catch((err: unknown) => {
          store.updateStatus(repo.id, 'error', { error: String(err) });
        });

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('HX-Trigger', 'close-panel');
      res.setHeader('HX-Trigger-After-Swap', 'refresh-repo-list');
      res.status(200).send('');
    } catch (err) {
      next(err);
    }
  });

  // GET /api/repos/:id/status — return status badge (polled by HTMX)
  router.get('/repos/:id/status', (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      const repo = store.getRepo(id);

      if (repo === undefined) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(404).send('<span class="badge badge--failed">Not found</span>');
        return;
      }

      const html = eta.render('partials/repo-item', { repo });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/repos/:id/retry — re-trigger clone for repos in error state
  router.post('/repos/:id/retry', (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      const repo = store.getRepo(id);

      if (repo === undefined) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(404).send('<span class="badge badge--failed">Not found</span>');
        return;
      }

      if (repo.status !== 'error') {
        const html = eta.render('partials/repo-item', { repo });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(200).send(html);
        return;
      }

      store.updateStatus(repo.id, 'cloning');
      deps.worktreeManager
        .ensureBareRepo(repo.url)
        .then((barePath) => {
          store.updateStatus(repo.id, 'ready', { barePath });
        })
        .catch((err: unknown) => {
          store.updateStatus(repo.id, 'error', { error: String(err) });
        });

      const updatedRepo = store.getRepo(id)!;
      const html = eta.render('partials/repo-item', { repo: updatedRepo });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/repos/:id — delete repo
  router.delete('/repos/:id', (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      store.deleteRepo(id);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send('<span></span>');
    } catch (err) {
      next(err);
    }
  });

  return router;
}
