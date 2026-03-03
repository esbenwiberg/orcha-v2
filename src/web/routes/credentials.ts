import { Router } from 'express';
import type { Eta } from 'eta';
import type { AppDeps } from '../app.js';
import { CredentialStore } from '../../db/credential-store.js';
import { credentialManager } from '../../credentials/credential-manager.js';
import type { ActiveCredentials } from '../../credentials/types.js';
import { formatRelativeTime, formatExpiresIn } from '../views/helpers.js';

function credExpiryPct(creds: ActiveCredentials): number {
  // We don't store createdAt separately in the panel view model — use a 4h window as default
  const nowMs = Date.now();
  const expiresMs = creds.expiresAt.getTime();
  const createdMs = creds.createdAt.getTime();
  const total = expiresMs - createdMs;
  const remaining = expiresMs - nowMs;
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((remaining / total) * 100)));
}

function toCredViewModel(creds: ActiveCredentials) {
  const nowMs = Date.now();
  const expiresMs = creds.expiresAt.getTime();
  const remainingMs = expiresMs - nowMs;
  return {
    id: creds.id,
    sessionId: creds.sessionId,
    profileId: creds.profileId,
    profileName: creds.profileName,
    expiresAt: creds.expiresAt.toISOString(),
    expiresInFormatted: formatExpiresIn(creds.expiresAt),
    isExpired: remainingMs <= 0,
    isExpiringSoon: remainingMs > 0 && remainingMs < 30 * 60_000,
    pct: credExpiryPct(creds),
    revokedAt: creds.revokedAt?.toISOString(),
  };
}

export function createCredentialsRouter(eta: Eta, deps: AppDeps): Router {
  const router = Router();
  const store = new CredentialStore(deps.db);

  // ── Credential Profiles ──────────────────────────────────────────────────

  // GET /api/credential-profiles — render profiles list partial (page view)
  router.get('/credential-profiles', (_req, res, next) => {
    try {
      const profiles = store.listProfiles();
      const html = eta.render('partials/credential-profiles-list', { profiles });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/credential-profiles/form — render create form partial
  router.get('/credential-profiles/form', (_req, res, next) => {
    try {
      const html = eta.render('partials/credential-profile-form', {});
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/credential-profiles — create a profile
  router.post('/credential-profiles', (req, res, next) => {
    try {
      const body = req.body as Record<string, string | string[]>;
      const name = String(body['name'] ?? '').trim();
      const durationHours = parseInt(String(body['durationHours'] ?? '4'), 10);

      if (!name) {
        res.status(422).send('<div class="badge badge--failed">Name is required</div>');
        return;
      }

      // Azure
      let azure: { subscriptionId: string; resourceGroups: string[]; role: string } | undefined;
      const azSub = String(body['azureSubscriptionId'] ?? '').trim();
      if (azSub) {
        azure = {
          subscriptionId: azSub,
          resourceGroups: String(body['azureResourceGroups'] ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          role: String(body['azureRole'] ?? 'Contributor').trim(),
        };
      }

      // GitHub
      let github: { pat?: string } | undefined;
      const ghPat = String(body['githubPat'] ?? '').trim();
      if (ghPat) {
        github = { pat: ghPat };
      }

      // DevOps
      let devops: { org: string; project: string; scopes: string[] } | undefined;
      const adoOrg = String(body['devopsOrg'] ?? '').trim();
      if (adoOrg) {
        const rawScopes = body['devopsScopes'];
        devops = {
          org: adoOrg,
          project: String(body['devopsProject'] ?? '').trim(),
          scopes: Array.isArray(rawScopes)
            ? rawScopes.map((s) => s.trim()).filter(Boolean)
            : typeof rawScopes === 'string'
              ? [rawScopes.trim()].filter(Boolean)
              : [],
        };
      }

      store.createProfile({
        name,
        durationHours,
        ...(azure !== undefined ? { azure } : {}),
        ...(github !== undefined ? { github } : {}),
        ...(devops !== undefined ? { devops } : {}),
      });

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('HX-Trigger', 'close-panel');
      res.setHeader('HX-Trigger-After-Swap', 'refresh-cred-list');
      res.status(200).send('');
    } catch (err) {
      next(err);
    }
  });

  // GET /api/credential-profiles/:id/edit-form — render edit form pre-populated
  router.get('/credential-profiles/:id/edit-form', (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      const profile = store.getProfile(id);

      if (!profile) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(404).send('<div class="badge badge--failed">Profile not found</div>');
        return;
      }

      const html = eta.render('partials/credential-profile-form', {
        editId: profile.id,
        name: profile.name,
        durationHours: profile.durationHours,
        azure: profile.azure,
        github: profile.github,
        devops: profile.devops,
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/credential-profiles/:id — update a profile
  router.put('/credential-profiles/:id', (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      const body = req.body as Record<string, string | string[]>;
      const name = String(body['name'] ?? '').trim();
      const durationHours = parseInt(String(body['durationHours'] ?? '4'), 10);

      if (!name) {
        res.status(422).send('<div class="badge badge--failed">Name is required</div>');
        return;
      }

      // Azure
      let azure: { subscriptionId: string; resourceGroups: string[]; role: string } | undefined;
      const azSub = String(body['azureSubscriptionId'] ?? '').trim();
      if (azSub) {
        azure = {
          subscriptionId: azSub,
          resourceGroups: String(body['azureResourceGroups'] ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          role: String(body['azureRole'] ?? 'Contributor').trim(),
        };
      }

      // GitHub
      let github: { pat?: string } | undefined;
      const ghPat = String(body['githubPat'] ?? '').trim();
      if (ghPat) {
        github = { pat: ghPat };
      }

      // DevOps
      let devops: { org: string; project: string; scopes: string[] } | undefined;
      const adoOrg = String(body['devopsOrg'] ?? '').trim();
      if (adoOrg) {
        const rawScopes = body['devopsScopes'];
        devops = {
          org: adoOrg,
          project: String(body['devopsProject'] ?? '').trim(),
          scopes: Array.isArray(rawScopes)
            ? rawScopes.map((s) => s.trim()).filter(Boolean)
            : typeof rawScopes === 'string'
              ? [rawScopes.trim()].filter(Boolean)
              : [],
        };
      }

      store.updateProfile(id, {
        name,
        durationHours,
        ...(azure !== undefined ? { azure } : {}),
        ...(github !== undefined ? { github } : {}),
        ...(devops !== undefined ? { devops } : {}),
      });

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('HX-Trigger', 'close-panel');
      res.setHeader('HX-Trigger-After-Swap', 'refresh-cred-list');
      res.status(200).send('');
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/credential-profiles/:id — delete a profile
  router.delete('/credential-profiles/:id', (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      store.deleteProfile(id);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  // ── Active Credentials ───────────────────────────────────────────────────

  // GET /api/credentials/active — render active credentials table (page view)
  router.get('/credentials/active', (_req, res, next) => {
    try {
      const activeCreds = store.listAll().filter((c) => !c.revokedAt);
      const html = eta.render('partials/active-credentials-table', {
        activeCreds: activeCreds.map(toCredViewModel),
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/credentials/:id/revoke — revoke a credential set
  router.post('/credentials/:id/revoke', async (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      const creds = store.getById(id);

      if (!creds) {
        res.status(404).send('<div class="badge badge--failed">Not found</div>');
        return;
      }

      await credentialManager.revoke(creds).catch((err) => {
        console.warn(`Best-effort credential revoke failed for ${id}:`, err);
      });
      store.markRevoked(id);

      // Re-render remaining active credentials
      const activeCreds = store.listAll().filter((c) => !c.revokedAt);
      const html = eta.render('partials/active-credentials-table', {
        activeCreds: activeCreds.map(toCredViewModel),
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/credentials/revoke-expired — bulk revoke expired credentials
  router.post('/credentials/revoke-expired', async (req, res, next) => {
    try {
      const expired = store.listExpired();

      await Promise.allSettled(
        expired.map(async (creds) => {
          await credentialManager.revoke(creds).catch(() => {});
          store.markRevoked(creds.id);
        }),
      );

      // Re-render the active credentials table
      const activeCreds = store.listAll().filter((c) => !c.revokedAt);
      const html = eta.render('partials/active-credentials-table', {
        activeCreds: activeCreds.map(toCredViewModel),
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/credentials/overview — render credentials panel partial
  router.get('/credentials/overview', (_req, res, next) => {
    try {
      const activeCreds = store.listAll().filter((c) => !c.revokedAt);
      const html = eta.render('partials/credentials-panel', {
        activeCreds: activeCreds.map(toCredViewModel),
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
