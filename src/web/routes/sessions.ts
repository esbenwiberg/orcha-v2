import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Eta } from 'eta';
import type { AppDeps } from '../app.js';
import { SessionStore } from '../../db/session-store.js';
import { RepoStore } from '../../db/repo-store.js';
import { CredentialStore } from '../../db/credential-store.js';
import { ModelConfigStore } from '../../db/model-config-store.js';
import { credentialManager } from '../../credentials/credential-manager.js';
import { buildModelEnv, ENV_DELETE } from '../../model-config/env-builder.js';
import { extractAuthUrl } from '../../terminal/auth-terminal-manager.js';
import type { Session } from '@orcha/domain';
import { formatRelativeTime, formatExpiresIn } from '../views/helpers.js';
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

interface SessionCardViewModel {
  id: string;
  branch: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  credentials?: CredStripViewModel;
  /** Model provider type — used to show auth URL polling slot for 'max' sessions. */
  modelProvider?: string;
}

function toViewModel(
  session: Session,
  creds?: import('../../credentials/types.js').ActiveCredentials,
  modelProvider?: string,
): SessionCardViewModel {
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
    ...(modelProvider !== undefined ? { modelProvider } : {}),
  };
}

export function createSessionsRouter(eta: Eta, deps: AppDeps): Router {
  const router = Router();
  const store = new SessionStore(deps.db);
  const repoStore = new RepoStore(deps.db);
  const credStore = new CredentialStore(deps.db);
  const modelConfigStore = new ModelConfigStore(deps.db);

  // GET /api/sessions/new-form — render the new-session form partial
  router.get('/sessions/new-form', (_req, res, next) => {
    try {
      const repos = repoStore.listRepos();
      const credentialProfiles = credStore.listProfiles();
      const modelConfigs = modelConfigStore.listConfigs();
      const html = eta.render('partials/new-session-form', { repos, credentialProfiles, modelConfigs });
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
      const credentialProfileId = (typeof req.body['credentialProfileId'] === 'string' ? req.body['credentialProfileId'] : '').trim();
      const modelConfigId = (typeof req.body['modelConfigId'] === 'string' ? req.body['modelConfigId'] : '').trim();
      // Checkboxes: present = "1"
      const sandbox = req.body['sandbox'] === '1';
      const skipPermissions = req.body['skipPermissions'] === '1';

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

      if (modelConfigId.length === 0) {
        errors.push('A model configuration must be selected.');
      } else if (!modelConfigStore.getConfig(modelConfigId)) {
        errors.push('Selected model configuration not found.');
      }

      if (errors.length > 0) {
        const modelConfigs = modelConfigStore.listConfigs();
        const formHtml = eta.render('partials/new-session-form', { repos, credentialProfiles, modelConfigs, repoId, branch, credentialProfileId, modelConfigId, sandbox, skipPermissions });
        const html = eta.render('partials/form-error', { errors, formHtml });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(422).send(html);
        return;
      }

      const repo = repoStore.getRepo(repoId)!;

      // Provision credentials if a profile was selected
      const env: Record<string, string> = {};
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

      // Inject model config env vars if a model config was selected.
      // Collect keys to delete so they're truly removed from the spawned env
      // (not just absent from opts.env — process.env would still leak through).
      const deleteEnvKeys: string[] = [];
      if (modelConfigId) {
        const modelConfig = modelConfigStore.getConfig(modelConfigId);
        if (modelConfig) {
          const modelEnv = buildModelEnv(modelConfig);
          for (const [key, value] of Object.entries(modelEnv)) {
            if (value === ENV_DELETE) {
              deleteEnvKeys.push(key);
            } else {
              env[key] = value;
            }
          }
        }
      }

      // Per-session isolated HOME: every session gets its own /tmp/orcha-home-<id>/
      // so concurrent sessions with different credentials don't overwrite each other,
      // and each session gets its own MCP server config for validation tools.
      const sessionId = randomUUID();
      {
        try {
          const sessionHome = join('/tmp', `orcha-home-${sessionId}`);
          const claudeDir = join(sessionHome, '.claude');
          mkdirSync(claudeDir, { recursive: true });

          // Build settings.json for this session: start from shared settings,
          // then ensure theme=dark is set so claude skips the first-run picker.
          const sharedSettings = join(homedir(), '.claude', 'settings.json');
          let settings: Record<string, unknown> = {};
          if (existsSync(sharedSettings)) {
            try { settings = JSON.parse(readFileSync(sharedSettings, 'utf8')) as Record<string, unknown>; } catch { /* ignore */ }
          }
          if (!('theme' in settings)) settings['theme'] = 'dark';

          // Inject MCP validation server config
          const orchaPort = process.env['PORT'] ?? '3001';
          const mcpServers = (settings['mcpServers'] ?? {}) as Record<string, unknown>;
          mcpServers['validate'] = {
            type: 'sse',
            url: `http://localhost:${orchaPort}/mcp/validate/${sessionId}`,
          };
          settings['mcpServers'] = mcpServers;

          writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(settings), 'utf8');

          // Inject model credentials if available
          if (modelConfigId) {
            const modelConfig = modelConfigStore.getConfig(modelConfigId);
            if (modelConfig?.credentialsJson) {
              const credsPath = join(claudeDir, '.credentials.json');
              writeFileSync(credsPath, modelConfig.credentialsJson, 'utf8');

              // Diagnostic: verify credentials were written and check expiry
              try {
                const readback = readFileSync(credsPath, 'utf8');
                const parsed = JSON.parse(readback) as Record<string, unknown>;
                const expiresAt = parsed['expiresAt'] as string | undefined;
                const isExpired = expiresAt ? new Date(expiresAt).getTime() < Date.now() : 'no-expiry';
                console.log(`[sessions] credentials injected sessionId=${sessionId} path=${credsPath} expired=${isExpired} expiresAt=${expiresAt ?? 'none'} provider=${modelConfig.provider}`);
              } catch (readErr) {
                console.warn(`[sessions] credentials readback failed sessionId=${sessionId}:`, readErr);
              }
            }
          }

          env['HOME'] = sessionHome;
          console.log(`[sessions] per-session HOME=${sessionHome} sessionId=${sessionId}`);
        } catch (err) {
          console.warn('[sessions] Failed to create per-session home dir:', err);
        }
      }

      // Create a real session with worktree + PTY via the session engine
      const claudeArgs = skipPermissions ? ['--dangerously-skip-permissions'] : [];
      const sessionHome = env['HOME'];
      const modelConfig = modelConfigId ? modelConfigStore.getConfig(modelConfigId) : undefined;
      const createOpts: Parameters<typeof deps.sessionEngine.createSession>[0] = {
        sessionId,
        branch,
        command: 'claude',
        args: claudeArgs,
        env,
        sandbox,
        ...(deleteEnvKeys.length > 0 ? { deleteEnv: deleteEnvKeys } : {}),
        ...(sessionHome !== undefined ? { homeDir: sessionHome } : {}),
        ...(modelConfigId ? { modelConfigId } : {}),
        ...(modelConfig !== undefined ? { modelProvider: modelConfig.provider } : {}),
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

      // Redirect to home so the session grid is always visible regardless of
      // which page the user is on when they submit the form.
      res.setHeader('HX-Redirect', '/');
      res.status(201).send('');
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

  // POST /api/sessions/:id/stop — send SIGTERM to the PTY and mark cancelled
  router.post('/sessions/:id/stop', (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';

      const existing = store.getSession(id);
      if (existing === undefined) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(404).send('<div class="badge badge--failed">Session not found</div>');
        return;
      }

      // Kill the PTY if still running in memory
      const activeSession = deps.sessionEngine.getSessionByDbId(id);
      if (activeSession) {
        deps.sessionEngine.stopSession(activeSession.sessionId).catch(() => {});
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

  // POST /api/sessions/:id/kill — send SIGKILL to the PTY and mark cancelled
  router.post('/sessions/:id/kill', (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';

      const existing = store.getSession(id);
      if (existing === undefined) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(200).send("<div style='display:none'></div>");
        return;
      }

      // Force-kill the PTY if still running in memory
      const activeSession = deps.sessionEngine.getSessionByDbId(id);
      if (activeSession) {
        try {
          activeSession.terminal.kill('SIGKILL');
        } catch {
          // Already dead
        }
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

  // POST /api/sessions/:id/reopen — reopen a failed or cancelled session
  router.post('/sessions/:id/reopen', async (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';

      const existing = store.getSession(id);
      if (existing === undefined) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(404).send('<div class="badge badge--failed">Session not found</div>');
        return;
      }

      if (existing.status !== 'failed' && existing.status !== 'cancelled') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(422).send('<div class="badge badge--failed">Session cannot be reopened</div>');
        return;
      }

      const activeSession = await deps.sessionEngine.reopenSession(id);
      eventBus.publish({ sessionId: activeSession.sessionId, type: 'status', status: 'running' });

      res.setHeader('HX-Redirect', '/');
      res.status(200).send('');
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/sessions/:id — delete session record (kills PTY first if still running)
  router.delete('/sessions/:id', async (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';

      const existing = store.getSession(id);
      if (existing === undefined) {
        res.status(404).send('');
        return;
      }

      // Kill PTY if still active
      const activeSession = deps.sessionEngine.getSessionByDbId(id);
      if (activeSession) {
        try {
          await deps.sessionEngine.stopSession(activeSession.sessionId);
        } catch {
          try { activeSession.terminal.kill('SIGKILL'); } catch { /* ignore */ }
        }
      }

      // Clean up worktree on disk before removing the DB record
      const worktreePath = existing.worktree.worktreePath;
      const worktreeSessionId = basename(worktreePath);
      try {
        await deps.worktreeManager.removeWorktree(worktreeSessionId);
      } catch {
        // Best-effort: worktree may already be gone
      }

      // Clean up per-session isolated HOME dir
      try {
        rmSync(join('/tmp', `orcha-home-${worktreeSessionId}`), { recursive: true, force: true });
      } catch {
        // Best-effort
      }

      store.deleteSession(id);
      // Return empty 200 — HTMX hx-swap="delete" will remove the card element
      res.status(200).send('');
    } catch (err) {
      next(err);
    }
  });

  // GET /api/sessions/:id/terminal — render the terminal panel partial
  router.get('/sessions/:id/terminal', (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      const session = store.getSession(id);
      const branch = session?.worktree?.branch ?? 'unknown';
      const status = session?.status ?? 'unknown';
      const html = eta.render('partials/terminal-panel', { id, branch, status });
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
      const viewModels = sessions.map((s) => {
        const active = deps.sessionEngine.getSessionByDbId(s.id);
        return toViewModel(s, credStore.getBySessionId(s.id), active?.modelProvider);
      });
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

      const active = deps.sessionEngine.getSessionByDbId(id);
      const creds = credStore.getBySessionId(id);
      const html = eta.render('partials/session-card', toViewModel(session, creds, active?.modelProvider));
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/sessions/:id/send-input — write text to the session's PTY
  router.post('/sessions/:id/send-input', (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      const text = typeof req.body['text'] === 'string' ? req.body['text'] : '';

      if (!text) {
        res.status(400).send('');
        return;
      }

      const active = deps.sessionEngine.getSessionByDbId(id);
      if (!active || active.terminal.exitCode !== undefined) {
        res.status(404).send('');
        return;
      }

      active.terminal.write(text + '\r');
      console.log(`[sessions] send-input sessionId=${id} length=${text.length}`);

      // After pasting an auth code, Claude prompts through several screens:
      // submit code → disclaimer → trust folder → possibly more.
      // Auto-dismiss with staggered Enters at generous intervals.
      if (active.modelProvider === 'max') {
        active.authCodeSentAt = Date.now();
        const delays = [2000, 5000, 8000, 11000];
        delays.forEach((delay, i) => {
          setTimeout(() => {
            try { active.terminal.write('\r'); } catch { /* exited */ }
            console.log(`[sessions] post-auth auto-dismiss #${i + 1} sessionId=${id}`);
          }, delay);
        });
      }

      res.status(200).send('');
    } catch (err) {
      next(err);
    }
  });

  // GET /api/sessions/:id/auth-url — poll for auth URL or credential capture
  router.get('/sessions/:id/auth-url', (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      res.setHeader('Content-Type', 'text/html; charset=utf-8');

      const active = deps.sessionEngine.getSessionByDbId(id);
      if (!active) {
        // Session exited or not found — stop polling
        res.status(200).send('');
        return;
      }

      // Tier 3: Check if credentials were refreshed after in-session auth.
      // Compare file content to what's stored in the model config — if different,
      // Claude Code refreshed the tokens during in-session auth.
      if (active.homeDir && active.modelConfigId) {
        const credsPath = join(active.homeDir, '.claude', '.credentials.json');
        if (existsSync(credsPath)) {
          try {
            const credsJson = readFileSync(credsPath, 'utf8');
            const currentConfig = modelConfigStore.getConfig(active.modelConfigId);
            const isRefreshed = currentConfig?.credentialsJson !== credsJson;

            if (isRefreshed) {
              modelConfigStore.updateConfig(active.modelConfigId, { credentialsJson: credsJson });
              console.log(`[sessions] captured refreshed credentials sessionId=${id} modelConfigId=${active.modelConfigId}`);
              const html = eta.render('partials/session-auth-banner', { authenticated: true });
              res.status(200).send(html);
              return;
            }
          } catch {
            // Ignore parse errors, fall through to URL detection
          }
        }
      }

      // If auth code was sent and enough time passed, assume auth succeeded
      // (credential file may not change if tokens were already valid).
      if (active.authCodeSentAt && Date.now() - active.authCodeSentAt > 15_000) {
        const html = eta.render('partials/session-auth-banner', { authenticated: true });
        res.status(200).send(html);
        return;
      }

      // Tier 2: Check terminal output for login URL
      const snapshot = active.outputBuffer.snapshot();
      const authUrl = extractAuthUrl(snapshot);

      if (authUrl) {
        const html = eta.render('partials/session-auth-banner', { authenticated: false, authUrl, sessionId: id });
        res.status(200).send(html);
        return;
      }

      // No URL found yet — return empty, keep polling
      const ageMs = Date.now() - active.createdAt.getTime();
      if (ageMs > 60_000 && active.terminal.exitCode !== undefined) {
        // Session exited without auth URL — stop polling
        res.status(200).send('');
        return;
      }

      // Still waiting — return polling stub
      const html = eta.render('partials/session-auth-banner', { waiting: true });
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/upload-image — save a pasted image from the clipboard
  router.post('/upload-image', (req, res, next) => {
    try {
      const data = typeof req.body['data'] === 'string' ? req.body['data'] : '';
      const filename = typeof req.body['filename'] === 'string' ? req.body['filename'] : 'paste.png';

      if (!data) {
        res.status(400).json({ error: 'No image data' });
        return;
      }

      // Extract base64 payload from data URL (data:image/png;base64,...)
      const match = data.match(/^data:[^;]+;base64,(.+)$/);
      if (!match) {
        res.status(400).json({ error: 'Invalid data URL' });
        return;
      }

      const buffer = Buffer.from(match[1]!, 'base64');
      const ext = filename.split('.').pop() || 'png';
      const dir = '/tmp/orcha-images';
      mkdirSync(dir, { recursive: true });

      const ts = Date.now();
      const rand = randomUUID().slice(0, 8);
      const outName = `${ts}-${rand}.${ext}`;
      const outPath = join(dir, outName);
      writeFileSync(outPath, buffer);

      console.log(`[sessions] upload-image path=${outPath} size=${buffer.length}`);
      res.json({ path: outPath });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
