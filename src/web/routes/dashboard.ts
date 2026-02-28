import { Router } from 'express';
import type { Eta } from 'eta';

function newSessionBtn(): string {
  return `<button
    class="btn btn-primary"
    hx-get="/api/sessions/new-form"
    hx-target="#form-panel-slot"
    hx-swap="innerHTML"
    onclick="document.getElementById('form-panel').classList.add('is-open')"
  >+ New Session</button>`;
}

function newPresetBtn(): string {
  return `<button
    class="btn btn-primary"
    hx-get="/api/presets/save-form"
    hx-target="#form-panel-slot"
    hx-swap="innerHTML"
    onclick="document.getElementById('form-panel').classList.add('is-open')"
  >+ New Preset</button>`;
}

function addRepoBtn(): string {
  return `<button
    class="btn btn-primary"
    hx-get="/api/repos/add-form"
    hx-target="#form-panel-slot"
    hx-swap="innerHTML"
    onclick="document.getElementById('form-panel').classList.add('is-open')"
  >+ Add Repo</button>`;
}

function newProfileBtn(): string {
  return `<button
    class="btn btn-primary"
    hx-get="/api/credential-profiles/form"
    hx-target="#form-panel-slot"
    hx-swap="innerHTML"
    onclick="document.getElementById('form-panel').classList.add('is-open')"
  >+ New Profile</button>`;
}

function newModelConfigBtn(): string {
  return `<button
    class="btn btn-primary"
    hx-get="/api/model-configs/form"
    hx-target="#form-panel-slot"
    hx-swap="innerHTML"
    onclick="document.getElementById('form-panel').classList.add('is-open')"
  >+ New Config</button>`;
}

export function createDashboardRouter(eta: Eta): Router {
  const router = Router();

  // GET / — sessions dashboard
  router.get('/', (_req, res, next) => {
    try {
      const body = eta.render('dashboard', {});
      const html = eta.render('layout', {
        title: 'Orcha – Sessions',
        pageTitle: 'Sessions',
        activeNav: 'sessions',
        headerActions: newSessionBtn(),
        body,
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /presets — presets management page
  router.get('/presets', (_req, res, next) => {
    try {
      const body = eta.render('presets-page', {});
      const html = eta.render('layout', {
        title: 'Orcha – Presets',
        pageTitle: 'Presets',
        activeNav: 'presets',
        headerActions: newPresetBtn(),
        body,
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /repos — repos management page
  router.get('/repos', (_req, res, next) => {
    try {
      const body = eta.render('repos-page', {});
      const html = eta.render('layout', {
        title: 'Orcha – Repos',
        pageTitle: 'Repositories',
        activeNav: 'repos',
        headerActions: addRepoBtn(),
        body,
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /credentials — credential profiles + active credentials
  router.get('/credentials', (_req, res, next) => {
    try {
      const body = eta.render('credentials-page', {});
      const html = eta.render('layout', {
        title: 'Orcha – Credentials',
        pageTitle: 'Credentials',
        activeNav: 'credentials',
        headerActions: newProfileBtn(),
        body,
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /models — model configs page
  router.get('/models', (_req, res, next) => {
    try {
      const body = eta.render('model-configs-page', {});
      const html = eta.render('layout', {
        title: 'Orcha – Models',
        pageTitle: 'Models',
        activeNav: 'models',
        headerActions: newModelConfigBtn(),
        body,
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /settings — Claude permissions editor
  router.get('/settings', (_req, res, next) => {
    try {
      const body = eta.render('settings-page', {});
      const html = eta.render('layout', {
        title: 'Orcha – Settings',
        pageTitle: 'Settings',
        activeNav: 'settings',
        body,
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /system — system health + disk usage
  router.get('/system', (_req, res, next) => {
    try {
      const body = eta.render('health-page', {});
      const html = eta.render('layout', {
        title: 'Orcha – System',
        pageTitle: 'System',
        activeNav: 'system',
        body,
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /guide — how to use Orcha
  router.get('/guide', (_req, res, next) => {
    try {
      const body = eta.render('guide-page', {});
      const html = eta.render('layout', {
        title: 'Orcha – Guide',
        pageTitle: 'Guide',
        activeNav: 'guide',
        body,
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /about — design & tech stack
  router.get('/about', (_req, res, next) => {
    try {
      const body = eta.render('about-page', {});
      const html = eta.render('layout', {
        title: 'Orcha – About',
        pageTitle: 'About',
        activeNav: 'about',
        body,
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
