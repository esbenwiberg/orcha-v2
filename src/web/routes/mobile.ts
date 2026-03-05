import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { mkdirSync, writeFileSync, existsSync, readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Eta } from 'eta';
import type { AppDeps } from '../app.js';
import { SessionStore } from '../../db/session-store.js';
import { CredentialStore } from '../../db/credential-store.js';
import { PresetStore } from '../../db/preset-store.js';
import { RepoStore } from '../../db/repo-store.js';
import { ModelConfigStore } from '../../db/model-config-store.js';
import { GlobalSettingsStore } from '../../db/global-settings-store.js';
import { readSettingsFromDb } from './claude-settings-db.js';
import { getClaudeFileContent } from './claude-files.js';
import { credentialManager } from '../../credentials/credential-manager.js';
import { buildModelEnv, ENV_DELETE } from '../../model-config/env-builder.js';
import { formatRelativeTime, formatExpiresIn } from '../views/helpers.js';
import { eventBus } from '../services/event-bus.js';

/** Allowed characters for a git branch name (simplified). */
const BRANCH_RE = /^[a-zA-Z0-9/_.-]+$/;

export function createMobileRouter(eta: Eta, deps: AppDeps): Router {
  const router = Router();
  const store = new SessionStore(deps.db);
  const credStore = new CredentialStore(deps.db);
  const presetStore = new PresetStore(deps.db);
  const repoStore = new RepoStore(deps.db);
  const modelConfigStore = new ModelConfigStore(deps.db);
  const globalSettingsStore = new GlobalSettingsStore(deps.db);

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

      // Render preset bar if presets exist
      const presets = presetStore.listPresets();
      const presetBarHtml = presets.length > 0
        ? eta.render('partials/mobile-preset-bar', { presets })
        : '';

      const html = eta.render('partials/mobile-sessions-list', { sessionItemsHtml, presetBarHtml });
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

  // POST /launch-preset/:presetId — create a session from a preset and connect
  router.post('/launch-preset/:presetId', async (req, res, next) => {
    try {
      const presetId = req.params['presetId'] ?? '';
      const preset = presetStore.getPreset(presetId);
      if (preset === undefined) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(404).send('<div class="connecting-msg connecting-msg--error">Preset not found.</div>');
        return;
      }

      // Validate repo
      const repo = preset.repoId ? repoStore.getRepo(preset.repoId) : undefined;
      if (!repo || repo.status !== 'ready') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(422).send('<div class="connecting-msg connecting-msg--error">Repo not ready.</div>');
        return;
      }

      // Validate model config
      const modelConfig = preset.modelConfigId ? modelConfigStore.getConfig(preset.modelConfigId) : undefined;
      if (!modelConfig) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(422).send('<div class="connecting-msg connecting-msg--error">Model config not found.</div>');
        return;
      }

      // Provision credentials if a profile was selected
      const env: Record<string, string> = {};
      let provisionedCreds: import('../../credentials/credential-manager.js').ProvisionResult | undefined;

      if (preset.credentialProfileId) {
        const profile = credStore.getProfile(preset.credentialProfileId);
        if (profile) {
          try {
            provisionedCreds = await credentialManager.provision(profile);
            Object.assign(env, provisionedCreds.env);
          } catch (err) {
            console.warn('[mobile] Credential provisioning failed, continuing with ambient credentials:', err);
          }
        }
      }

      // Build model env vars
      const deleteEnvKeys: string[] = [];
      const modelEnv = buildModelEnv(modelConfig);
      for (const [key, value] of Object.entries(modelEnv)) {
        if (value === ENV_DELETE) {
          deleteEnvKeys.push(key);
        } else {
          env[key] = value;
        }
      }

      // Per-session isolated HOME for credential injection
      const sessionId = randomUUID();
      if (modelConfig.credentialsJson) {
        try {
          const sessionHome = join('/tmp', `orcha-home-${sessionId}`);
          const claudeDir = join(sessionHome, '.claude');
          mkdirSync(claudeDir, { recursive: true });

          // Copy global .gitconfig so git works on Azure File Share (fileMode + safe.directory)
          const srcGitconfig = join(homedir(), '.gitconfig');
          if (existsSync(srcGitconfig)) {
            copyFileSync(srcGitconfig, join(sessionHome, '.gitconfig'));
          }

          // Generate .git-credentials from session env so git push/pull can authenticate
          const ghToken = env['GH_TOKEN'] ?? env['GITHUB_TOKEN'];
          if (ghToken) {
            writeFileSync(join(sessionHome, '.git-credentials'), `https://oauth2:${ghToken}@github.com\n`);
          }

          const settings: Record<string, unknown> = readSettingsFromDb(globalSettingsStore);
          if (!('theme' in settings)) settings['theme'] = 'dark';

          // Deny web tools when preset has web access disabled
          if (!preset.webAccess) {
            const perms = (settings['permissions'] ?? {}) as Record<string, unknown>;
            const deny = Array.isArray(perms['deny']) ? [...perms['deny']] : [];
            if (!deny.includes('WebFetch')) deny.push('WebFetch');
            if (!deny.includes('WebSearch')) deny.push('WebSearch');
            perms['deny'] = deny;
            settings['permissions'] = perms;
          }

          writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(settings), 'utf8');
          writeFileSync(join(claudeDir, '.credentials.json'), modelConfig.credentialsJson, 'utf8');

          // Inject CLAUDE.md and soul.md from global settings (if configured)
          const claudeMd = getClaudeFileContent(globalSettingsStore, 'claude_md');
          if (claudeMd) writeFileSync(join(claudeDir, 'CLAUDE.md'), claudeMd, 'utf8');
          const soulMd = getClaudeFileContent(globalSettingsStore, 'soul_md');
          if (soulMd) writeFileSync(join(claudeDir, 'soul.md'), soulMd, 'utf8');

          env['HOME'] = sessionHome;
        } catch (err) {
          console.warn('[mobile] Failed to create per-session home dir:', err);
        }
      }

      // Use user-supplied branch name if valid, otherwise auto-generate
      const rawBranch = typeof req.body?.branch === 'string' ? req.body.branch.trim() : '';
      let branch: string;
      if (rawBranch.length > 0 && BRANCH_RE.test(rawBranch)) {
        branch = rawBranch;
      } else {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        branch = `${preset.name.replace(/\s+/g, '-').toLowerCase()}/${ts}`;
      }

      const sessionHome = env['HOME'];
      const createOpts: Parameters<typeof deps.sessionEngine.createSession>[0] = {
        sessionId,
        branch,
        command: 'claude',
        args: [],
        env,
        sandbox: false,
        ...(deleteEnvKeys.length > 0 ? { deleteEnv: deleteEnvKeys } : {}),
        ...(sessionHome !== undefined ? { homeDir: sessionHome } : {}),
        ...(preset.modelConfigId ? { modelConfigId: preset.modelConfigId } : {}),
        ...(modelConfig !== undefined ? { modelProvider: modelConfig.provider } : {}),
      };
      if (repo.barePath !== null) {
        createOpts.repoRoot = repo.barePath;
      }

      const activeSession = await deps.sessionEngine.createSession(createOpts);

      // Persist credential records
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
          console.warn('[mobile] Failed to persist credential record to DB:', err);
        }
      }

      eventBus.publish({ sessionId: activeSession.sessionId, type: 'created' });

      // Set mobile session cookie and return terminal frame
      const dbSessionId = activeSession.dbSessionId ?? sessionId;
      res.setHeader(
        'Set-Cookie',
        `mobile-session-id=${dbSessionId}; SameSite=Strict; Path=/mobile`,
      );

      const proto = req.protocol === 'https' ? 'wss' : 'ws';
      const wsUrl = `${proto}://${req.get('host') ?? 'localhost'}/ws/terminal/${activeSession.sessionId}`;

      const launchModelProvider = modelConfig?.provider;
      const html = eta.render('partials/mobile-terminal-frame', { sessionId: dbSessionId, wsUrl, ...(launchModelProvider !== undefined ? { modelProvider: launchModelProvider } : {}) });
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
