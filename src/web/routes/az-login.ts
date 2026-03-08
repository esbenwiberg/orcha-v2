import { Router } from 'express';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Eta } from 'eta';
import type { AppDeps } from '../app.js';
import { SessionStore } from '../../db/session-store.js';
import { extractAzDeviceCode, extractAzAccount } from '../../terminal/az-device-code.js';

export function createAzLoginRouter(eta: Eta, deps: AppDeps): Router {
  const router = Router();
  const store = new SessionStore(deps.db);

  // POST /az-login/session/:sessionId — session-scoped az login (uses session's AZURE_CONFIG_DIR)
  router.post('/az-login/session/:sessionId', (req, res, next) => {
    try {
      const sessionId = req.params['sessionId'] ?? '';
      const session = store.getSession(sessionId);
      if (session === undefined) {
        res.status(404).send('Session not found');
        return;
      }

      // Spawn debug shell (inherits session env including AZURE_CONFIG_DIR)
      // with az login --use-device-code
      const shell = deps.sessionEngine.spawnDebugShell(sessionId, {
        command: 'az',
        args: ['login', '--use-device-code'],
      });

      const html = eta.render('partials/az-device-code-banner', {
        shellId: shell.shellId,
        sessionId,
        scope: 'session',
        status: 'pending',
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // POST /az-login/host — host-scoped az login (uses ~/.azure)
  router.post('/az-login/host', (_req, res, next) => {
    try {
      const shell = deps.sessionEngine.spawnStandaloneShell({
        command: 'az',
        args: ['login', '--use-device-code'],
      });

      const html = eta.render('partials/az-device-code-banner', {
        shellId: shell.shellId,
        scope: 'host',
        status: 'pending',
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /az-login/:shellId/status — poll for device code / completion
  router.get('/az-login/:shellId/status', (req, res, next) => {
    try {
      const shellId = req.params['shellId'] ?? '';
      const shell = deps.sessionEngine.getDebugShell(shellId);

      if (shell === undefined) {
        // Shell gone — either completed and cleaned up, or never existed.
        // Check if it exited successfully by trying az account show.
        const html = eta.render('partials/az-device-code-banner', {
          shellId,
          status: 'complete',
        });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        // 286 tells htmx to stop polling
        res.status(286).send(html);
        return;
      }

      const snapshot = shell.outputBuffer.snapshot();
      const deviceCode = extractAzDeviceCode(snapshot);
      const account = extractAzAccount(snapshot);

      let status: string;
      if (account) {
        status = 'success';
      } else if (deviceCode) {
        status = 'authenticating';
      } else {
        status = 'pending';
      }

      const html = eta.render('partials/az-device-code-banner', {
        shellId,
        status,
        ...(deviceCode !== null ? { url: deviceCode.url, code: deviceCode.code } : {}),
        ...(account !== null ? { account } : {}),
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      // 286 tells htmx to stop polling — send when login is complete
      res.status(status === 'success' ? 286 : 200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /az-login/host-status — current host az account status
  router.get('/az-login/host-status', (_req, res, next) => {
    try {
      let account: { name: string; subscription: string } | null = null;

      try {
        const raw = execSync('az account show --output json 2>/dev/null', {
          timeout: 5000,
          env: { ...process.env, HOME: homedir(), AZURE_CONFIG_DIR: join(homedir(), '.azure') },
        }).toString('utf8');
        const parsed = JSON.parse(raw) as { user?: { name?: string }; name?: string };
        if (parsed.user?.name) {
          account = {
            name: parsed.user.name,
            subscription: parsed.name ?? '',
          };
        }
      } catch {
        // az CLI not installed or not signed in
      }

      const html = eta.render('partials/settings-azure', { account });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
