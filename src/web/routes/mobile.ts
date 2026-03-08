import { Router } from 'express';
import type { Eta } from 'eta';
import type { AppDeps } from '../app.js';
import { SessionStore } from '../../db/session-store.js';
import { CredentialStore } from '../../db/credential-store.js';
import { RepoStore } from '../../db/repo-store.js';
import { formatRelativeTime, formatExpiresIn } from '../views/helpers.js';

export function createMobileRouter(eta: Eta, deps: AppDeps): Router {
  const router = Router();
  const store = new SessionStore(deps.db);
  const credStore = new CredentialStore(deps.db);
  const repoStore = new RepoStore(deps.db);

  // GET / — mobile shell with bottom-tab navigation
  router.get('/', (_req, res, next) => {
    try {
      const html = eta.render('mobile', {
        title: 'Orcha – Mobile',
        pageTitle: 'Sessions',
        activeTab: 'sessions',
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /sessions — render the sessions list partial for HTMX swap
  router.get('/sessions', (_req, res, next) => {
    try {
      const sessions = store.listSessions();

      // Build barePath → displayName map for repo name resolution
      const repoNameMap = new Map<string, string>();
      for (const repo of repoStore.listRepos()) {
        if (repo.barePath !== null) {
          repoNameMap.set(repo.barePath, repo.displayName);
        }
      }

      // Render each session item and concatenate them
      const sessionItemsHtml = sessions
        .map((session) =>
          eta.render('partials/mobile-session-item', {
            sessionId: session.id,
            repoName: repoNameMap.get(session.config.repoRoot),
            branch: session.worktree.branch,
            status: session.status,
          }),
        )
        .join('');

      const html = eta.render('partials/mobile-sessions-list', { sessionItemsHtml });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /terminal/:sessionId — render the xterm terminal frame partial
  router.get('/terminal/:sessionId', (req, res, next) => {
    try {
      const sessionId = req.params['sessionId'] ?? '';

      // Parse mobile-session-id cookie manually (cookie-parser is not in use)
      const cookieHeader = req.headers.cookie ?? '';
      const match = /mobile-session-id=([^;]+)/.exec(cookieHeader);
      const activeId = match?.[1];

      // Security: prevent session hopping — only serve the frame for the active session
      if (activeId !== sessionId) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(403).send('<div class="connecting-msg connecting-msg--error">Session mismatch.</div>');
        return;
      }

      const session = store.getSession(sessionId);
      if (session === undefined) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(404).send('<div class="connecting-msg connecting-msg--error">Session not found.</div>');
        return;
      }

      const proto = req.protocol === 'https' ? 'wss' : 'ws';
      const wsUrl = `${proto}://${req.get('host') ?? 'localhost'}/ws/terminal/${sessionId}`;

      const active = deps.sessionEngine.getSessionByDbId(sessionId);
      const modelProvider = active?.modelProvider;
      const html = eta.render('partials/mobile-terminal-frame', { sessionId, wsUrl, ...(modelProvider !== undefined ? { modelProvider } : {}) });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // POST /connect/:sessionId — set active session cookie and return the terminal frame
  router.post('/connect/:sessionId', (req, res, next) => {
    try {
      const sessionId = req.params['sessionId'] ?? '';

      const session = store.getSession(sessionId);
      if (session === undefined) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(404).send('<div class="connecting-msg connecting-msg--error">Session not found.</div>');
        return;
      }

      res.setHeader(
        'Set-Cookie',
        `mobile-session-id=${sessionId}; SameSite=Strict; Path=/mobile`,
      );

      const proto = req.protocol === 'https' ? 'wss' : 'ws';
      const wsUrl = `${proto}://${req.get('host') ?? 'localhost'}/ws/terminal/${sessionId}`;

      const active = deps.sessionEngine.getSessionByDbId(sessionId);
      const modelProvider = active?.modelProvider;
      const html = eta.render('partials/mobile-terminal-frame', { sessionId, wsUrl, ...(modelProvider !== undefined ? { modelProvider } : {}) });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /session-info — render the info panel for the active mobile session
  router.get('/session-info', (req, res, next) => {
    try {
      const cookieHeader = req.headers.cookie ?? '';
      const match = /mobile-session-id=([^;]+)/.exec(cookieHeader);
      const activeId = match?.[1];

      if (!activeId) {
        const html = eta.render('partials/mobile-info-panel', { session: null });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(200).send(html);
        return;
      }

      const session = store.getSession(activeId);
      if (session === undefined) {
        const html = eta.render('partials/mobile-info-panel', { session: null });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(200).send(html);
        return;
      }

      const creds = credStore.getBySessionId(activeId);
      let credentials: { id: string; profileName: string; expiresInFormatted: string; isExpired: boolean; isExpiringSoon: boolean } | undefined;
      if (creds && !creds.revokedAt) {
        const remainingMs = creds.expiresAt.getTime() - Date.now();
        credentials = {
          id: creds.id,
          profileName: creds.profileName,
          expiresInFormatted: formatExpiresIn(creds.expiresAt),
          isExpired: remainingMs <= 0,
          isExpiringSoon: remainingMs > 0 && remainingMs < 30 * 60_000,
        };
      }

      const active = deps.sessionEngine.getSessionByDbId(activeId);
      const modelProvider = active?.modelProvider;
      const repo = repoStore.getRepoByBarePath(session.config.repoRoot);

      const html = eta.render('partials/mobile-info-panel', {
        session: {
          id: session.id,
          repoName: repo?.displayName,
          branch: session.worktree.branch,
          status: session.status,
          createdAt: formatRelativeTime(session.createdAt),
          updatedAt: formatRelativeTime(session.updatedAt),
        },
        ...(credentials !== undefined ? { credentials } : {}),
        ...(modelProvider !== undefined ? { modelProvider } : {}),
        ...(repo?.deployCommand ? { hasDeployCommand: true } : {}),
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /action-sheet/:sessionId — return the action sheet partial
  router.get('/action-sheet/:sessionId', (req, res, next) => {
    try {
      const sessionId = req.params['sessionId'] ?? '';
      const session = store.getSession(sessionId);

      if (session === undefined) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(404).send('<div class="connecting-msg connecting-msg--error">Session not found.</div>');
        return;
      }

      const html = eta.render('partials/mobile-action-sheet', {
        sessionId: session.id,
        branch: session.worktree.branch,
        status: session.status,
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
