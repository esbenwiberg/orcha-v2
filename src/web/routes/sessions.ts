import { Router } from 'express';
import type { Eta } from 'eta';
import type { AppDeps } from '../app.js';
import { SessionStore } from '../../db/session-store.js';
import { RepoStore } from '../../db/repo-store.js';
import { CredentialStore } from '../../db/credential-store.js';
import { credentialManager } from '../../credentials/credential-manager.js';
import type { Session } from '@orcha/domain';
import { formatRelativeTime } from '../views/helpers.js';
import { eventBus } from '../services/event-bus.js';

/** Allowed characters for a git branch name (simplified). */
const BRANCH_RE = /^[a-zA-Z0-9/_-]+$/;

interface CredStripViewModel {
  id: string;
  profileName: string;
  expiresAt: string;
  expiresInFormatted: string;
  isExpired: boolean;
  isExpiringSoon: boolean;
}

function formatExpiresIn(expiresAt: Date): string {
  const ms = expiresAt.getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

interface SessionCardViewModel {
  id: string;
  branch: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  credentials?: CredStripViewModel;
}

function toViewModel(session: Session, creds?: import('../../credentials/types.js').ActiveCredentials): SessionCardViewModel {
  let credentials: CredStripViewModel | undefined;
  if (creds && !creds.revokedAt) {
    const remainingMs = creds.expiresAt.getTime() - Date.now();
    credentials = {
      id: creds.id,
      profileName: creds.profileName,
      expiresAt: creds.expiresAt.toISOString(),
      expiresInFormatted: formatExpiresIn(creds.expiresAt),
      isExpired: remainingMs <= 0,
      isExpiringSoon: remainingMs > 0 && remainingMs < 30 * 60_000,
    };
  }
  return {
    id: session.id,
    branch: session.worktree.branch,
    status: session.status,
    createdAt: formatRelativeTime(session.createdAt),
    updatedAt: formatRelativeTime(session.updatedAt),
    ...(credentials !== undefined ? { credentials } : {}),
  };
}

export function createSessionsRouter(eta: Eta, deps: AppDeps): Router {
  const router = Router();
  const store = new SessionStore(deps.db);
  const repoStore = new RepoStore(deps.db);
  const credStore = new CredentialStore(deps.db);

  // GET /api/sessions/new-form — render the new-session form partial
  router.get('/sessions/new-form', (_req, res, next) => {
    try {
      const repos = repoStore.listRepos();
      const credentialProfiles = credStore.listProfiles();
      const html = eta.render('partials/new-session-form', { repos, credentialProfiles });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/sessions — create session from HTMX form submission
  router.post('/sessions', async (req, res, next) => {
    try {
      const repoId = (typeof req.body['repoId'] === 'string' ? req.body['repoId'] : '').trim();
      const branch = (typeof req.body['branch'] === 'string' ? req.body['branch'] : '').trim();
      const prompt = (typeof req.body['prompt'] === 'string' ? req.body['prompt'] : '').trim();
      const credentialProfileId = (typeof req.body['credentialProfileId'] === 'string' ? req.body['credentialProfileId'] : '').trim();

      // Validate
      const errors: string[] = [];
      const repos = repoStore.listRepos();
      const credentialProfiles = credStore.listProfiles();

      if (repoId.length === 0) {
        errors.push('A repository must be selected.');
      } else {
        const repo = repoStore.getRepo(repoId);
        if (repo === undefined) {
          errors.push('Selected repository not found.');
        } else if (repo.status !== 'ready') {
          errors.push('Selected repository is not ready yet.');
        }
      }

      if (branch.length === 0) {
        errors.push('Branch name is required.');
      } else if (!BRANCH_RE.test(branch)) {
        errors.push('Branch name may only contain letters, numbers, /, _ and -.');
      }

      if (prompt.length === 0) {
        errors.push('Initial prompt is required.');
      }

      if (errors.length > 0) {
        const formHtml = eta.render('partials/new-session-form', { repos, credentialProfiles, repoId, branch, prompt });
        const html = eta.render('partials/form-error', { errors, formHtml });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(422).send(html);
        return;
      }

      const repo = repoStore.getRepo(repoId)!;

      // Provision credentials if a profile was selected
      const env: Record<string, string> = { ORCHA_PROMPT: prompt };
      let provisionedCreds: import('../../credentials/credential-manager.js').ProvisionResult | undefined;

      if (credentialProfileId) {
        const profile = credStore.getProfile(credentialProfileId);
        if (profile) {
          try {
            provisionedCreds = await credentialManager.provision(profile);
            Object.assign(env, provisionedCreds.env);
          } catch (err) {
            console.warn('Credential provisioning failed, continuing with ambient credentials:', err);
          }
        }
      }

      // Create a real session with worktree + PTY via the session engine
      const createOpts: Parameters<typeof deps.sessionEngine.createSession>[0] = {
        branch,
        command: 'bash',
        env,
      };
      if (repo.barePath !== null) {
        createOpts.repoRoot = repo.barePath;
      }
      const activeSession = await deps.sessionEngine.createSession(createOpts);

      // Persist provisioned credentials with the session ID now that we have it
      if (provisionedCreds && activeSession.dbSessionId) {
        try {
          const { activeCreds } = provisionedCreds;
          credStore.createSessionCredentials({
            sessionId: activeSession.dbSessionId,
            profileId: activeCreds.profileId,
            profileName: activeCreds.profileName,
            expiresAt: activeCreds.expiresAt,
            ...(activeCreds.azureSpName !== undefined ? { azureSpName: activeCreds.azureSpName } : {}),
            ...(activeCreds.azureAppId !== undefined ? { azureAppId: activeCreds.azureAppId } : {}),
            ...(activeCreds.githubPatId !== undefined ? { githubPatId: activeCreds.githubPatId } : {}),
            ...(activeCreds.devopsPatId !== undefined ? { devopsPatId: activeCreds.devopsPatId } : {}),
          });
        } catch (err) {
          console.warn('Failed to persist credential record to DB:', err);
        }
      }

      eventBus.publish({ sessionId: activeSession.sessionId, type: 'created' });

      // Fetch the DB session for the card view model
      const dbSession = activeSession.dbSessionId !== undefined
        ? store.getSession(activeSession.dbSessionId)
        : undefined;

      if (dbSession !== undefined) {
        const html = eta.render('partials/session-card', toViewModel(dbSession));
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('HX-Trigger', 'close-panel');
        res.setHeader('HX-Retarget', '#session-grid');
        res.setHeader('HX-Reswap', 'afterbegin');
        res.status(201).send(html);
      } else {
        // Fallback: render a minimal card
        const html = eta.render('partials/session-card', {
          id: activeSession.sessionId,
          branch: activeSession.worktree.branch,
          status: 'running',
          createdAt: formatRelativeTime(activeSession.createdAt),
          updatedAt: formatRelativeTime(activeSession.createdAt),
        });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('HX-Trigger', 'close-panel');
        res.setHeader('HX-Retarget', '#session-grid');
        res.setHeader('HX-Reswap', 'afterbegin');
        res.status(201).send(html);
      }
    } catch (err) {
      next(err);
    }
  });

  // GET /api/sessions/:id/confirm — render the inline confirmation dialog
  router.get('/sessions/:id/confirm', (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      const action = req.query['action'];

      if (action !== 'stop' && action !== 'kill') {
        res.status(400).send('<div class="badge badge--failed">Invalid action</div>');
        return;
      }

      const message =
        action === 'stop'
          ? 'Send SIGTERM to this session?'
          : 'Force-kill this session? (SIGKILL — no cleanup)';
      const confirmLabel = action === 'stop' ? 'Stop' : 'Kill';

      const html = eta.render('partials/confirm-dialog', { id, action, message, confirmLabel });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/sessions/:id/stop — cancel session with SIGTERM semantics
  router.post('/sessions/:id/stop', (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';

      const existing = store.getSession(id);
      if (existing === undefined) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(404).send('<div class="badge badge--failed">Session not found</div>');
        return;
      }

      // Attempt to transition to cancelled; if already terminal, just re-render as-is
      let session: Session;
      try {
        session = store.updateStatus(id, 'cancelled');
        eventBus.publish({ sessionId: id, type: 'status', status: 'cancelled' });
      } catch {
        // Transition invalid (session already completed/failed/cancelled) — re-render current state
        session = existing;
      }

      const html = eta.render('partials/session-card', toViewModel(session));
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/sessions/:id/kill — force-cancel session with SIGKILL semantics
  router.post('/sessions/:id/kill', (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';

      const existing = store.getSession(id);
      if (existing === undefined) {
        // Session not found — swap card out silently
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(200).send("<div style='display:none'></div>");
        return;
      }

      // Attempt to transition to cancelled; if already terminal, just re-render as-is
      let session: Session;
      try {
        session = store.updateStatus(id, 'cancelled');
        eventBus.publish({ sessionId: id, type: 'status', status: 'cancelled' });
      } catch {
        session = existing;
      }

      const html = eta.render('partials/session-card', toViewModel(session));
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/sessions/:id/terminal — render the terminal panel partial
  router.get('/sessions/:id/terminal', (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      const html = eta.render('partials/terminal-panel', { id });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/sessions/cards — render the full session grid partial
  router.get('/sessions/cards', (_req, res, next) => {
    try {
      const sessions = store.listSessions();
      const viewModels = sessions.map((s) => toViewModel(s, credStore.getBySessionId(s.id)));
      const html = eta.render('partials/session-grid', { sessions: viewModels });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/sessions/:id/card — render a single session card partial
  router.get('/sessions/:id/card', (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      const session = store.getSession(id);

      if (session === undefined) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(404).send('<div></div>');
        return;
      }

      const creds = credStore.getBySessionId(id);
      const html = eta.render('partials/session-card', toViewModel(session, creds));
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
