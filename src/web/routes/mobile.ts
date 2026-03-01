import { Router } from 'express';
import type { Eta } from 'eta';
import type { AppDeps } from '../app.js';
import { SessionStore } from '../../db/session-store.js';
import { CredentialStore } from '../../db/credential-store.js';
import { formatRelativeTime, formatExpiresIn } from '../views/helpers.js';

/** Minimal HTML-escape to prevent XSS in inline error messages. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function createMobileRouter(eta: Eta, deps: AppDeps): Router {
  const router = Router();
  const store = new SessionStore(deps.db);
  const credStore = new CredentialStore(deps.db);

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

      // Render each session item and concatenate them
      const sessionItemsHtml = sessions
        .map((session) =>
          eta.render('partials/mobile-session-item', {
            sessionId: session.id,
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

      const html = eta.render('partials/mobile-terminal-frame', { sessionId, wsUrl });
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
        `mobile-session-id=${sessionId}; HttpOnly; SameSite=Strict; Path=/mobile`,
      );

      const proto = req.protocol === 'https' ? 'wss' : 'ws';
      const wsUrl = `${proto}://${req.get('host') ?? 'localhost'}/ws/terminal/${sessionId}`;

      const html = eta.render('partials/mobile-terminal-frame', { sessionId, wsUrl });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /status-stream — SSE stream that polls the active session's PTY liveness every 5s
  router.get('/status-stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    /** Build the SSE event payload for #conn-badge. */
    function buildStatusEvent(live: boolean): string {
      const cls = live ? 'conn-live' : 'conn-disconnected';
      const label = live ? '&#9679;&nbsp;Live' : '&#9679;&nbsp;Disconnected';
      const span = `<span id="conn-badge" class="conn-badge ${cls}" aria-live="polite">${label}</span>`;
      return `event: connStatus\ndata: ${span}\n\n`;
    }

    /** Parse the mobile-session-id cookie and check whether its terminal is alive. */
    function isSessionLive(): boolean {
      const cookieHeader = req.headers.cookie ?? '';
      const match = /mobile-session-id=([^;]+)/.exec(cookieHeader);
      const activeId = match?.[1];
      if (!activeId) return false;
      const session = deps.sessionEngine.getSession(activeId);
      return session !== undefined && session.terminal !== undefined;
    }

    // Send the initial event immediately so the badge reflects current state at page load.
    res.write(buildStatusEvent(isSessionLive()));

    const interval = setInterval(() => {
      res.write(buildStatusEvent(isSessionLive()));
    }, 5000);

    req.on('close', () => {
      clearInterval(interval);
      res.end();
    });
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

      const html = eta.render('partials/mobile-info-panel', {
        session: {
          id: session.id,
          branch: session.worktree.branch,
          status: session.status,
          createdAt: formatRelativeTime(session.createdAt),
          updatedAt: formatRelativeTime(session.updatedAt),
        },
        ...(credentials !== undefined ? { credentials } : {}),
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

  // GET /send-modal — return the send modal partial for HTMX injection
  router.get('/send-modal', (_req, res, next) => {
    try {
      const html = eta.render('partials/mobile-send-modal', {});
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // POST /send — write text to the active session's PTY input
  router.post('/send', (req, res) => {
    // Parse the active session cookie manually (no cookie-parser)
    const cookieHeader = req.headers.cookie ?? '';
    const match = /mobile-session-id=([^;]+)/.exec(cookieHeader);
    const activeId = match?.[1];

    if (!activeId) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(401).send('<span class="send-error">No active session</span>');
      return;
    }

    const rawText: unknown = req.body?.text;
    if (typeof rawText !== 'string' || rawText.trim().length === 0) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(400).send('<span class="send-error">Text is required</span>');
      return;
    }

    if (rawText.length > 4096) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(400).send('<span class="send-error">Text exceeds 4096 character limit</span>');
      return;
    }

    const session = deps.sessionEngine.getSession(activeId);
    if (session === undefined) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(404).send('<span class="send-error">Session not found</span>');
      return;
    }

    try {
      // Append \n so the command is submitted in the PTY; strip any trailing
      // newline the user may have already typed to avoid a double submission.
      session.terminal.write(rawText.replace(/\r?\n$/, '') + '\n');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send('<span class="send-success">Sent</span>');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(500).send(`<span class="send-error">Failed: ${escapeHtml(message)}</span>`);
    }
  });

  return router;
}
