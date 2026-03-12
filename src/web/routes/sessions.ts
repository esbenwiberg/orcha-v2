import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, readdirSync, statSync, realpathSync, copyFileSync, appendFileSync } from 'node:fs';
import { basename, join, resolve, relative, extname } from 'node:path';
import { marked } from 'marked';
import type { Eta } from 'eta';
import type { AppDeps } from '../app.js';
import { SessionStore } from '../../db/session-store.js';
import { RepoStore } from '../../db/repo-store.js';
import { CredentialStore } from '../../db/credential-store.js';
import { TaskStore } from '../../db/task-store.js';
import { ModelConfigStore } from '../../db/model-config-store.js';
import { GlobalSettingsStore } from '../../db/global-settings-store.js';
import { readSettingsFromDb } from './claude-settings-db.js';
import { buildSessionClaudeMd } from './claude-files.js';
import { loadSkills } from './skills.js';
import { credentialManager } from '../../credentials/credential-manager.js';
import { buildModelEnv, ENV_DELETE } from '../../model-config/env-builder.js';
import { McpServerStore } from '../../db/mcp-server-store.js';
import { extractAuthUrl, stripAnsi } from '../../terminal/auth-terminal-manager.js';
import { executeGit } from '../utils/git-utils.js';
import type { Session } from '@orcha/domain';
import { formatRelativeTime, formatExpiresIn } from '../views/helpers.js';
import { eventBus } from '../services/event-bus.js';
import { ensureSdksInstalled } from '../../sdk-installer.js';
import { getStoragePaths } from '../../storage/paths.js';
import { writeFeedConfigs } from '../../credentials/feed-config.js';
import { loadFeedConfig } from './feeds.js';
import { parsePrUrl, fetchPrComments, formatPrReview } from '../../pr-review/index.js';
import type { PrInfo } from '../../pr-review/index.js';

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
  repoName: string;
  branch: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  credentials?: CredStripViewModel;
  /** Model provider type — used to show auth URL polling slot for 'max' sessions. */
  modelProvider?: string;
  /** Deploy command from repo settings — when set, shows Deploy button on card. */
  deployCommand?: string;
  /** Linked task info — when set, shows a "Task #N" badge on the card. */
  taskInfo?: { taskId: string; displayId: number; status: string };
  /** Exit code from the PTY process — shown on completed/failed cards. */
  exitCode?: number;
  /** True when this is an admin history analysis session. */
  isAdmin?: boolean;
  /** True when the session has captured JSONL history. */
  hasHistory?: boolean;
}

/** UUID pattern for detecting bare-repo directory names that are UUIDs. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Extract a short repo name from a bare-repo path like /data/bare-repos/my-app.git */
function repoNameFromPath(repoRoot: string): string {
  const base = basename(repoRoot).replace(/\.git$/, '');
  if (!base || UUID_RE.test(base)) return 'unknown';
  return base;
}

function toViewModel(
  session: Session,
  creds?: import('../../credentials/types.js').ActiveCredentials,
  modelProvider?: string,
  repoName?: string,
  deployCommand?: string | null,
  taskInfo?: { taskId: string; displayId: number; status: string },
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
    repoName: repoName ?? repoNameFromPath(session.config.repoRoot),
    branch: session.worktree.branch,
    status: session.status,
    createdAt: formatRelativeTime(session.createdAt),
    updatedAt: formatRelativeTime(session.updatedAt),
    ...(credentials !== undefined ? { credentials } : {}),
    ...(modelProvider !== undefined ? { modelProvider } : {}),
    ...(deployCommand ? { deployCommand } : {}),
    ...(taskInfo !== undefined ? { taskInfo } : {}),
    ...(session.exitCode !== undefined ? { exitCode: session.exitCode } : {}),
    ...(session.config.repoRoot === '__admin__' ? { isAdmin: true } : {}),
    ...(session.historyCapturedAt !== undefined ? { hasHistory: true } : {}),
  };
}

export function createSessionsRouter(eta: Eta, deps: AppDeps): Router {
  const router = Router();
  const store = new SessionStore(deps.db);
  const repoStore = new RepoStore(deps.db);
  const credStore = new CredentialStore(deps.db);
  const modelConfigStore = new ModelConfigStore(deps.db);
  const mcpServerStore = new McpServerStore(deps.db);
  const globalSettingsStore = new GlobalSettingsStore(deps.db);
  const taskStore = new TaskStore(deps.db);

  // GET /api/sessions/new-form — render the new-session form partial
  router.get('/sessions/new-form', (_req, res, next) => {
    try {
      const repos = repoStore.listRepos();
      const credentialProfiles = credStore.listProfiles();
      const modelConfigs = modelConfigStore.listConfigs();
      const mcpServers = mcpServerStore.listServers();
      const html = eta.render('partials/new-session-form', { repos, credentialProfiles, modelConfigs, mcpServers });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/repos/:id/branches — fetch latest refs and return branch options for HTMX swap
  router.get('/repos/:id/branches', async (req, res, next) => {
    try {
      const repoId = req.params['id'] ?? '';
      const repo = repoStore.getRepo(repoId);
      if (repo === undefined || repo.barePath === null) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(200).send('<option value="">No branches available</option>');
        return;
      }

      try {
        await deps.worktreeManager.fetchBareRepo(repo.barePath);
      } catch (err) {
        console.warn(`[sessions] fetchBareRepo failed for ${repoId}:`, err);
      }

      const branches = await deps.worktreeManager.listRemoteBranches(repo.barePath);
      const defaultBranch = await deps.worktreeManager.getDefaultBranch(repo.barePath);

      let html = '';
      for (const branch of branches) {
        if (branch === 'HEAD') continue;
        const isDefault = branch === defaultBranch;
        html += `<option value="origin/${branch}"${isDefault ? ' selected' : ''}>${branch}${isDefault ? ' (default)' : ''}</option>\n`;
      }
      if (html === '') {
        html = '<option value="">No branches found</option>';
      }

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/sessions — create session from HTMX form submission
  router.post('/sessions', async (req, res, next) => {
    try {
      let repoId = (typeof req.body['repoId'] === 'string' ? req.body['repoId'] : '').trim();
      let branch = (typeof req.body['branch'] === 'string' ? req.body['branch'] : '').trim();
      let sourceBranch = (typeof req.body['sourceBranch'] === 'string' ? req.body['sourceBranch'] : '').trim();
      const credentialProfileId = (typeof req.body['credentialProfileId'] === 'string' ? req.body['credentialProfileId'] : '').trim();
      const modelConfigId = (typeof req.body['modelConfigId'] === 'string' ? req.body['modelConfigId'] : '').trim();
      const prUrl = (typeof req.body['prUrl'] === 'string' ? req.body['prUrl'] : '').trim();
      // Checkboxes: present = "1"
      const sandbox = req.body['sandbox'] === '1';
      const skipPermissions = req.body['skipPermissions'] === '1';
      const webAccess = req.body['webAccess'] === '1';
      const privateFeeds = req.body['privateFeeds'] === '1';

      // mcpServerIds comes as repeated checkbox values — ensure array
      const rawMcpIds = req.body['mcpServerIds'];
      const mcpServerIds: string[] = Array.isArray(rawMcpIds)
        ? rawMcpIds.filter((v): v is string => typeof v === 'string')
        : typeof rawMcpIds === 'string' && rawMcpIds
          ? [rawMcpIds]
          : [];

      // PR review mode: if a PR URL is provided, parse it to resolve repo + branch
      let prInfo: PrInfo | undefined;
      const isPrMode = prUrl.length > 0;

      if (isPrMode) {
        try {
          const parsed = parsePrUrl(prUrl);
          // Auto-detect repo by matching owner/repo against registered repos
          if (repoId.length === 0) {
            const allRepos = repoStore.listRepos();
            const matchStr = `${parsed.owner}/${parsed.repo}`.toLowerCase();
            const matched = allRepos.find((r) => r.url.toLowerCase().includes(matchStr) && r.status === 'ready');
            if (matched) {
              repoId = matched.id;
            }
          }
        } catch (err) {
          // Invalid URL — will be caught in validation below
          console.warn('[sessions] Failed to parse PR URL:', err);
        }
      }

      // Validate
      const errors: string[] = [];
      const repos = repoStore.listRepos();
      const credentialProfiles = credStore.listProfiles();

      if (isPrMode && prUrl.length > 0) {
        try {
          parsePrUrl(prUrl);
        } catch {
          errors.push('Invalid PR URL. Supported: GitHub (github.com/.../pull/N) and Azure DevOps (dev.azure.com/...pullrequest/N).');
        }
      }

      if (repoId.length === 0) {
        errors.push(isPrMode ? 'Could not match PR URL to a registered repository. Select one manually.' : 'A repository must be selected.');
      } else {
        const repo = repoStore.getRepo(repoId);
        if (repo === undefined) {
          errors.push('Selected repository not found.');
        } else if (repo.status !== 'ready') {
          errors.push('Selected repository is not ready yet.');
        }
      }

      // In PR mode, branch name is auto-derived — skip validation for it
      if (!isPrMode) {
        if (branch.length === 0) {
          errors.push('Branch name is required.');
        } else if (!BRANCH_RE.test(branch)) {
          errors.push('Branch name may only contain letters, numbers, /, _ and -.');
        }
      }

      if (modelConfigId.length === 0) {
        errors.push('A model configuration must be selected.');
      } else if (!modelConfigStore.getConfig(modelConfigId)) {
        errors.push('Selected model configuration not found.');
      }

      // Branch collision guard: check if a session already uses this branch on this repo
      // (skip for PR mode — branch is resolved later after fetching PR metadata)
      if (!isPrMode && errors.length === 0 && branch.length > 0 && repoId.length > 0) {
        const repo = repoStore.getRepo(repoId);
        if (repo?.barePath) {
          const existing = store.findByBranchAndRepo(branch, repo.barePath);
          if (existing !== undefined) {
            const isAlive = existing.status === 'running' || existing.status === 'starting' || existing.status === 'pending';
            if (isAlive) {
              errors.push(`A session is already running on branch '${branch}' (session #${existing.displayId}).`);
            } else {
              errors.push(`Session #${existing.displayId} already uses branch '${branch}'. Reopen it, or delete it to free the branch name.`);
            }
          }
        }
      }

      if (errors.length > 0) {
        const modelConfigs = modelConfigStore.listConfigs();
        const mcpServers = mcpServerStore.listServers();
        const formHtml = eta.render('partials/new-session-form', { repos, credentialProfiles, modelConfigs, mcpServers, repoId, branch, sourceBranch, credentialProfileId, modelConfigId, mcpServerIds, sandbox, skipPermissions, webAccess, privateFeeds, prUrl });
        const html = eta.render('partials/form-error', { errors, formHtml });
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(422).send(html);
        return;
      }

      const repo = repoStore.getRepo(repoId)!;
      const sessionId = randomUUID();

      // Provision credentials if a profile was selected
      const env: Record<string, string> = {
        ORCHA_SESSION_ID: sessionId,
      };

      // 1. Repo-level env vars (lowest priority — overridable by credentials + model config)
      const repoEnvKeys = Object.keys(repo.envVars);
      if (repoEnvKeys.length > 0) {
        Object.assign(env, repo.envVars);
        console.log(`[sessions] injected ${repoEnvKeys.length} repo env var(s): ${repoEnvKeys.join(', ')} sessionId=${sessionId}`);
      }

      let provisionedCreds: import('../../credentials/credential-manager.js').ProvisionResult | undefined;

      if (credentialProfileId) {
        const profile = credStore.getProfile(credentialProfileId);
        if (profile) {
          try {
            provisionedCreds = await credentialManager.provision(profile);
            Object.assign(env, provisionedCreds.env);
          } catch (err) {
            // Credential provisioning failed — surface the error. Don't silently
            // fall back to ambient credentials (that defeats isolation).
            const hint = String(err).includes('401')
              ? ' The bootstrap PAT on the Settings page may be expired — update it and retry.'
              : '';
            console.error('Credential provisioning failed:', err);
            const modelConfigs = modelConfigStore.listConfigs();
            const mcpServers = mcpServerStore.listServers();
            const formHtml = eta.render('partials/new-session-form', { repos, credentialProfiles, modelConfigs, mcpServers, repoId, branch, sourceBranch, credentialProfileId, modelConfigId, mcpServerIds, sandbox, skipPermissions, webAccess, privateFeeds, prUrl });
            const html = eta.render('partials/form-error', { errors: [`Credential provisioning failed: ${String(err)}.${hint}`], formHtml });
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.status(422).send(html);
            return;
          }
        }
      }

      // Credential isolation: when a credential profile is selected, strip ambient
      // credential env vars from the spawned process so the session ONLY gets its
      // provisioned (scoped, time-limited) credentials — not the host's long-lived tokens.
      const deleteEnvKeys: string[] = [];
      if (credentialProfileId) {
        const credentialEnvKeys = [
          'AZURE_DEVOPS_EXT_PAT', 'AZURE_DEVOPS_PAT', 'DEVOPS_BOOTSTRAP_PAT',
          'GH_TOKEN', 'GITHUB_TOKEN',
        ];
        for (const key of credentialEnvKeys) {
          // Only strip keys that weren't explicitly set by provisioning
          if (env[key] === undefined) {
            deleteEnvKeys.push(key);
          }
        }
      }

      // Inject model config env vars if a model config was selected.
      // Collect keys to delete so they're truly removed from the spawned env
      // (not just absent from opts.env — process.env would still leak through).
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
      // Hoisted so it's accessible after createSession() for project-level injection
      let mcpServers: Record<string, unknown> = {};
      {
        try {
          const sessionHome = join('/tmp', `orcha-home-${sessionId}`);
          const claudeDir = join(sessionHome, '.claude');
          mkdirSync(claudeDir, { recursive: true });

          // Copy global .gitconfig so git works on Azure File Share (fileMode + safe.directory)
          const srcGitconfig = join(homedir(), '.gitconfig');
          if (existsSync(srcGitconfig)) {
            copyFileSync(srcGitconfig, join(sessionHome, '.gitconfig'));
          }

          // Generate .git-credentials from session env so git push/pull can authenticate.
          // GH_TOKEN comes from the credential profile's GitHub provider.
          const ghToken = env['GH_TOKEN'] ?? env['GITHUB_TOKEN'];
          if (ghToken) {
            writeFileSync(join(sessionHome, '.git-credentials'), `https://oauth2:${ghToken}@github.com\n`);
          }

          // Append git user identity from global settings (avoids "Author identity unknown")
          const gitUserName = globalSettingsStore.get('git.user.name');
          const gitUserEmail = globalSettingsStore.get('git.user.email');
          if (gitUserName || gitUserEmail) {
            let section = '\n[user]\n';
            if (gitUserName) section += `\tname = ${gitUserName}\n`;
            if (gitUserEmail) section += `\temail = ${gitUserEmail}\n`;
            appendFileSync(join(sessionHome, '.gitconfig'), section);
          }

          // Build settings.json for this session: start from DB-persisted settings,
          // then ensure theme=dark is set so claude skips the first-run picker.
          const settings: Record<string, unknown> = readSettingsFromDb(globalSettingsStore);
          if (!('theme' in settings)) settings['theme'] = 'dark';

          // Build MCP servers map — injected into both settings.json and .config.json
          mcpServers = {};
          if (mcpServerIds.length > 0) {
            const entries = mcpServerStore.getSettingsEntries(mcpServerIds);
            Object.assign(mcpServers, entries);
          }

          // Inject built-in MCP servers (type 'http' = StreamableHTTP)
          const orchaPort = process.env['PORT'] ?? '3000';
          mcpServers['validate'] = {
            type: 'http',
            url: `http://localhost:${orchaPort}/mcp/validate/${sessionId}`,
          };
          mcpServers['orcha'] = {
            type: 'http',
            url: `http://localhost:${orchaPort}/mcp/orcha`,
          };
          settings['mcpServers'] = mcpServers;

          // Deny web tools when web access is disabled
          if (!webAccess) {
            const perms = (settings['permissions'] ?? {}) as Record<string, unknown>;
            const deny = Array.isArray(perms['deny']) ? [...perms['deny']] : [];
            if (!deny.includes('WebFetch')) deny.push('WebFetch');
            if (!deny.includes('WebSearch')) deny.push('WebSearch');
            perms['deny'] = deny;
            settings['permissions'] = perms;
          }

          const settingsJson = JSON.stringify(settings);
          console.log(`[sessions] writing settings.json sessionId=${sessionId} mcpKeys=${Object.keys(mcpServers).join(',')} size=${settingsJson.length}`);
          writeFileSync(join(claudeDir, 'settings.json'), settingsJson, 'utf8');

          // Write .config.json — Claude Code reads MCP servers from the
          // TOP-LEVEL mcpServers key (user scope). Project trust lives under
          // projects.<cwd>.hasTrustDialogAccepted.
          const worktreePath = join(getStoragePaths().worktreeBaseDir, sessionId);
          const claudeConfig: Record<string, unknown> = {
            hasCompletedOnboarding: true,
            theme: 'dark',
            mcpServers,
            projects: {
              [worktreePath]: {
                hasTrustDialogAccepted: true,
                allowedTools: [],
              },
            },
          };
          if (modelConfigId) {
            const mc = modelConfigStore.getConfig(modelConfigId);
            if (mc?.apiKey) {
              // Claude Code identifies approved keys by their last 20 characters
              const keyFingerprint = mc.apiKey.slice(-20);
              claudeConfig['customApiKeyResponses'] = {
                approved: [keyFingerprint],
                rejected: [],
              };
            }
          }
          writeFileSync(join(claudeDir, '.config.json'), JSON.stringify(claudeConfig), 'utf8');

          // Inject merged CLAUDE.md (includes soul.md content inline so it's
          // auto-loaded by Claude Code — soul.md is not a natively recognised file)
          let mergedClaudeMd = buildSessionClaudeMd(globalSettingsStore);

          // Append PR review instructions if in PR mode
          if (isPrMode && prUrl) {
            const prInstructions = [
              '',
              '# PR Review Session',
              '',
              'This session was opened to work on PR comments.',
              `PR: ${prUrl}`,
              '',
              'A file with all PR comments has been written to `.orcha/pr-review.md` in the worktree.',
              'Read that file first to understand what needs to be addressed.',
              '',
              'Work through each active comment systematically:',
              '1. Read `.orcha/pr-review.md` to see all comments',
              '2. For each unresolved comment, make the requested changes',
              '3. If a comment is unclear, note your interpretation and proceed with the most reasonable fix',
              '',
            ].join('\n');
            mergedClaudeMd = mergedClaudeMd ? `${mergedClaudeMd}\n${prInstructions}` : prInstructions;
          }

          if (mergedClaudeMd) writeFileSync(join(claudeDir, 'CLAUDE.md'), mergedClaudeMd, 'utf8');

          // Inject skills into ~/.claude/skills/<name>/SKILL.md
          const skills = loadSkills(globalSettingsStore);
          for (const skill of skills) {
            const skillDir = join(claudeDir, 'skills', skill.name);
            mkdirSync(skillDir, { recursive: true });
            writeFileSync(join(skillDir, 'SKILL.md'), skill.content, 'utf8');
          }

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

          // Generate .npmrc + NuGet.Config for private Azure DevOps feeds
          if (privateFeeds) {
            const feedConfig = loadFeedConfig(globalSettingsStore);
            if (feedConfig) {
              const feedResult = writeFeedConfigs(sessionHome, feedConfig);
              Object.assign(env, feedResult.env);
              console.log(`[sessions] feed configs written sessionId=${sessionId} feeds=${feedConfig.feeds.join(',')}`);
            } else {
              console.warn(`[sessions] privateFeeds enabled but no feed config in settings sessionId=${sessionId}`);
            }
          }

          env['HOME'] = sessionHome;
          // Override DOTNET_CLI_HOME so dotnet finds NuGet.Config at $HOME/.nuget/
          // (Dockerfile sets DOTNET_CLI_HOME=/tmp/dotnet-cli which shadows HOME)
          env['DOTNET_CLI_HOME'] = sessionHome;

          // If repo/credential env vars set PATH, merge with (don't replace) the
          // system PATH — otherwise tools like npm, node, git become unfindable.
          if (env['PATH']) {
            const systemPath = process.env['PATH'] ?? '';
            env['PATH'] = `${env['PATH']}:${systemPath}`;
            console.log(`[sessions] merged custom PATH with system PATH sessionId=${sessionId}`);
          }

          console.log(`[sessions] per-session HOME=${sessionHome} sessionId=${sessionId}`);
        } catch (err) {
          console.warn('[sessions] Failed to create per-session home dir:', err);
        }
      }

      // Fetch latest refs from the bare repo before creating the worktree
      if (repo.barePath !== null) {
        try {
          await deps.worktreeManager.fetchBareRepo(repo.barePath);
        } catch (err) {
          console.warn(`[sessions] fetchBareRepo failed for ${repoId}:`, err);
        }
      }

      // Ensure repo-level SDKs are installed before spawning
      if (repo.sdks.length > 0) {
        try {
          ensureSdksInstalled(repo.sdks);
        } catch (err) {
          console.warn(`[sessions] SDK install failed for repo ${repoId}:`, err);
        }
      }

      // PR review mode: fetch PR metadata + comments, resolve branch, create worktree
      let existingWorktree: import('../../terminal/worktree-manager.js').WorktreeInfo | undefined;
      if (isPrMode) {
        try {
          // Fetch PR info (metadata + comments).
          // If a credential profile was selected, provisioning succeeded (failure is
          // a hard error above) and env has the scoped PAT. If no profile was selected,
          // fall back to ambient process.env tokens.
          const ghToken = env['GH_TOKEN'] ?? env['GITHUB_TOKEN'] ?? process.env['GH_TOKEN'] ?? '';
          const adoToken = env['AZURE_DEVOPS_EXT_PAT'] ?? env['AZURE_DEVOPS_PAT'] ?? (credentialProfileId ? '' : (process.env['AZURE_DEVOPS_EXT_PAT'] ?? process.env['AZURE_DEVOPS_PAT'] ?? ''));
          prInfo = await fetchPrComments({ prUrl, ghToken, adoToken });

          // Use the PR's source branch
          branch = prInfo.sourceBranch;
          sourceBranch = `origin/${prInfo.sourceBranch}`;
          console.log(`[sessions] PR review mode: branch=${branch} pr=${prInfo.title} comments=${prInfo.comments.length} sessionId=${sessionId}`);

          // Check branch collision now that we know the branch name
          if (repo.barePath) {
            const existing = store.findByBranchAndRepo(branch, repo.barePath);
            if (existing !== undefined) {
              const isAlive = existing.status === 'running' || existing.status === 'starting' || existing.status === 'pending';
              const msg = isAlive
                ? `A session is already running on PR branch '${branch}' (session #${existing.displayId}).`
                : `Session #${existing.displayId} already uses branch '${branch}'. Reopen it, or delete it to free the branch name.`;
              const modelConfigs = modelConfigStore.listConfigs();
              const mcpServers = mcpServerStore.listServers();
              const formHtml = eta.render('partials/new-session-form', { repos, credentialProfiles, modelConfigs, mcpServers, repoId, branch, sourceBranch, credentialProfileId, modelConfigId, mcpServerIds, sandbox, skipPermissions, webAccess, privateFeeds, prUrl });
              const html = eta.render('partials/form-error', { errors: [msg], formHtml });
              res.setHeader('Content-Type', 'text/html; charset=utf-8');
              res.status(422).send(html);
              return;
            }
          }

          // Create worktree by checking out the existing PR branch
          existingWorktree = await deps.worktreeManager.checkoutWorktree(sessionId, branch, repo.barePath ?? undefined);

          // Write PR review file to worktree
          const orchaDir = join(existingWorktree.path, '.orcha');
          mkdirSync(orchaDir, { recursive: true });
          writeFileSync(join(orchaDir, 'pr-review.md'), formatPrReview(prInfo), 'utf8');

          // Ensure .orcha/ is gitignored
          const gitignorePath = join(existingWorktree.path, '.gitignore');
          try {
            const existing = readFileSync(gitignorePath, 'utf8');
            if (!existing.includes('.orcha/')) {
              writeFileSync(gitignorePath, existing.trimEnd() + '\n.orcha/\n', 'utf8');
            }
          } catch {
            writeFileSync(gitignorePath, '.orcha/\n', 'utf8');
          }

          console.log(`[sessions] PR review written to ${orchaDir}/pr-review.md sessionId=${sessionId}`);
        } catch (err) {
          console.error('[sessions] PR review setup failed:', err);
          const modelConfigs = modelConfigStore.listConfigs();
          const mcpServers = mcpServerStore.listServers();
          const formHtml = eta.render('partials/new-session-form', { repos, credentialProfiles, modelConfigs, mcpServers, repoId, branch, sourceBranch, credentialProfileId, modelConfigId, mcpServerIds, sandbox, skipPermissions, webAccess, privateFeeds, prUrl });
          const html = eta.render('partials/form-error', { errors: [`PR review setup failed: ${String(err)}`], formHtml });
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.status(422).send(html);
          return;
        }
      }

      // Create a real session with worktree + PTY via the session engine
      const claudeArgs = skipPermissions ? ['--dangerously-skip-permissions'] : [];
      const sessionHome = env['HOME'];
      const modelConfig = modelConfigId ? modelConfigStore.getConfig(modelConfigId) : undefined;

      // Snapshot validation config from repo so the MCP validate tool has
      // deterministic defaults without needing to look up the repo at runtime.
      const validateConfig = repo.validateMode ? {
        ...(repo.validateMode !== null ? { validateMode: repo.validateMode } : {}),
        ...(repo.validateBuild !== null ? { validateBuild: repo.validateBuild } : {}),
        ...(repo.validateStart !== null ? { validateStart: repo.validateStart } : {}),
        ...(repo.validateHealth !== null ? { validateHealth: repo.validateHealth } : {}),
        ...(repo.validateHealthPort !== null ? { validateHealthPort: repo.validateHealthPort } : {}),
        ...(repo.validateComposeFile !== null ? { validateComposeFile: repo.validateComposeFile } : {}),
        validateTimeout: repo.validateTimeout,
        ...(repo.validateReadyDelay !== null ? { validateReadyDelay: repo.validateReadyDelay } : {}),
        ...(Object.keys(repo.validateEnv).length > 0 ? { validateEnv: repo.validateEnv } : {}),
      } : undefined;

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
        ...(sourceBranch ? { sourceBranch } : {}),
        ...(mcpServerIds.length > 0 ? { mcpServerIds } : {}),
        ...(privateFeeds ? { privateFeeds } : {}),
        ...(existingWorktree !== undefined ? { existingWorktree } : {}),
        ...(validateConfig !== undefined ? { validateConfig } : {}),
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

      // Redirect to the appropriate page — /mobile if submitted from mobile, / otherwise.
      const referer = req.get('referer') ?? '';
      const isMobile = referer.includes('/mobile');
      res.setHeader('HX-Redirect', isMobile ? '/mobile' : '/');
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
        res.status(400).send('<div class="badge badge-error">Invalid action</div>');
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
        res.status(404).send('<div class="badge badge-error">Session not found</div>');
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

      const repo = repoStore.getRepoByBarePath(session.config.repoRoot);
      const html = eta.render('partials/session-card', toViewModel(session, undefined, undefined, repo?.displayName, repo?.deployCommand));
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
        res.status(200).send('<div class="hidden"></div>');
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

      const repo = repoStore.getRepoByBarePath(session.config.repoRoot);
      const html = eta.render('partials/session-card', toViewModel(session, undefined, undefined, repo?.displayName, repo?.deployCommand));
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/sessions/:id/debug-shell — spawn a bash shell in the session's worktree
  router.post('/sessions/:id/debug-shell', (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';

      const existing = store.getSession(id);
      if (existing === undefined) {
        res.status(404).send('Session not found');
        return;
      }

      const shell = deps.sessionEngine.spawnDebugShell(id);
      const html = eta.render('partials/debug-shell-panel', {
        shellId: shell.shellId,
        sessionId: id,
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/sessions/:id/debug-shell/:shellId/stop — stop a debug shell
  router.post('/sessions/:id/debug-shell/:shellId/stop', (req, res, next) => {
    try {
      const shellId = req.params['shellId'] ?? '';
      try {
        deps.sessionEngine.stopDebugShell(shellId);
      } catch {
        // Already dead — fine
      }
      res.status(200).send('');
    } catch (err) {
      next(err);
    }
  });

  // POST /api/sessions/:id/host-shell — spawn an unsandboxed shell with host env
  router.post('/sessions/:id/host-shell', (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';

      const existing = store.getSession(id);
      if (existing === undefined) {
        res.status(404).send('Session not found');
        return;
      }

      const shell = deps.sessionEngine.spawnHostShell(id, { label: 'Host Shell' });
      const html = eta.render('partials/debug-shell-panel', {
        shellId: shell.shellId,
        sessionId: id,
        label: 'Host Shell',
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/sessions/:id/deploy — run repo's deploy command in a host shell
  router.post('/sessions/:id/deploy', (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';

      const existing = store.getSession(id);
      if (existing === undefined) {
        res.status(404).send('Session not found');
        return;
      }

      // Look up repo to get deploy command + deploy env vars
      const repo = repoStore.getRepoByBarePath(existing.config.repoRoot);
      if (!repo?.deployCommand) {
        res.status(422).send('No deploy command configured for this repo');
        return;
      }

      const shell = deps.sessionEngine.spawnHostShell(id, {
        command: [repo.deployCommand],
        extraEnv: repo.deployEnvVars,
        label: 'Deploy',
      });
      const html = eta.render('partials/debug-shell-panel', {
        shellId: shell.shellId,
        sessionId: id,
        label: 'Deploy',
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/sessions/:id/shells — list active debug/host/deploy shells for reconnection
  router.get('/sessions/:id/shells', (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      const active = deps.sessionEngine.getSessionByDbId(id);
      if (active === undefined) {
        res.status(200).send('');
        return;
      }

      const shells = deps.sessionEngine.listDebugShells(active.sessionId);
      if (shells.length === 0) {
        res.status(200).send('');
        return;
      }

      const html = shells
        .map((shell) =>
          eta.render('partials/debug-shell-panel', {
            shellId: shell.shellId,
            sessionId: id,
            ...(shell.label !== undefined ? { label: shell.label } : {}),
          }),
        )
        .join('');

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
        res.status(404).send('<div class="badge badge-error">Session not found</div>');
        return;
      }

      if (existing.status !== 'failed' && existing.status !== 'cancelled' && existing.status !== 'completed') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(422).send('<div class="badge badge-error">Session cannot be reopened</div>');
        return;
      }

      // Rebuild per-session HOME dir if it was lost (e.g. container restart).
      // The HOME dir lives on /tmp which is ephemeral; reopen must restore it
      // so git (.gitconfig safe.directory) and Claude (settings, credentials) work.
      const originalEnv = existing.config.env ?? {};
      const sessionHome = originalEnv['HOME'];
      if (sessionHome && !existsSync(join(sessionHome, '.gitconfig'))) {
        try {
          const claudeDir = join(sessionHome, '.claude');
          mkdirSync(claudeDir, { recursive: true });

          // Copy .gitconfig (safe.directory = *)
          const srcGitconfig = join(homedir(), '.gitconfig');
          if (existsSync(srcGitconfig)) {
            copyFileSync(srcGitconfig, join(sessionHome, '.gitconfig'));
          }

          // Generate .git-credentials from session env so git push/pull can authenticate
          const ghToken = originalEnv['GH_TOKEN'] ?? originalEnv['GITHUB_TOKEN'];
          if (ghToken) {
            writeFileSync(join(sessionHome, '.git-credentials'), `https://oauth2:${ghToken}@github.com\n`);
          }

          // Append git user identity from global settings
          const gitUserName = globalSettingsStore.get('git.user.name');
          const gitUserEmail = globalSettingsStore.get('git.user.email');
          if (gitUserName || gitUserEmail) {
            let section = '\n[user]\n';
            if (gitUserName) section += `\tname = ${gitUserName}\n`;
            if (gitUserEmail) section += `\temail = ${gitUserEmail}\n`;
            appendFileSync(join(sessionHome, '.gitconfig'), section);
          }

          // Rebuild settings.json with theme + MCP servers
          const settings: Record<string, unknown> = readSettingsFromDb(globalSettingsStore);
          if (!('theme' in settings)) settings['theme'] = 'dark';

          // Build MCP servers map — injected into both settings.json and .config.json
          const reopenMcpServers: Record<string, unknown> = {};
          const savedMcpIds = existing.config.mcpServerIds ?? [];
          if (savedMcpIds.length > 0) {
            const entries = mcpServerStore.getSettingsEntries(savedMcpIds);
            Object.assign(reopenMcpServers, entries);
          }

          const orchaPort = process.env['PORT'] ?? '3000';
          reopenMcpServers['validate'] = {
            type: 'http',
            url: `http://localhost:${orchaPort}/mcp/validate/${id}`,
          };
          reopenMcpServers['orcha'] = {
            type: 'http',
            url: `http://localhost:${orchaPort}/mcp/orcha`,
          };
          settings['mcpServers'] = reopenMcpServers;
          writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(settings), 'utf8');

          // Rebuild .config.json — MCP servers at top level, trust under projects key
          const reopenWorktreePath = join(getStoragePaths().worktreeBaseDir, id);
          const reopenConfig: Record<string, unknown> = {
            hasCompletedOnboarding: true,
            theme: 'dark',
            mcpServers: reopenMcpServers,
            projects: {
              [reopenWorktreePath]: {
                hasTrustDialogAccepted: true,
                allowedTools: [],
              },
            },
          };
          const reopenModelConfigId = existing.config.modelConfigId;
          if (reopenModelConfigId) {
            const mcStore = new ModelConfigStore(deps.db);
            const mc = mcStore.getConfig(reopenModelConfigId);
            if (mc?.apiKey) {
              const keyFingerprint = mc.apiKey.slice(-20);
              reopenConfig['customApiKeyResponses'] = {
                approved: [keyFingerprint],
                rejected: [],
              };
            }
          }
          writeFileSync(join(claudeDir, '.config.json'), JSON.stringify(reopenConfig), 'utf8');

          // Inject merged CLAUDE.md (includes soul.md content inline)
          const mergedClaudeMd = buildSessionClaudeMd(globalSettingsStore);
          if (mergedClaudeMd) writeFileSync(join(claudeDir, 'CLAUDE.md'), mergedClaudeMd, 'utf8');

          // Restore credentials if available
          const modelConfigId = existing.config.modelConfigId;
          if (modelConfigId) {
            const modelConfigStore = new ModelConfigStore(deps.db);
            const modelConfig = modelConfigStore.getConfig(modelConfigId);
            if (modelConfig?.credentialsJson) {
              writeFileSync(join(claudeDir, '.credentials.json'), modelConfig.credentialsJson, 'utf8');
            }
          }

          // Restore .npmrc + NuGet.Config for private feeds
          if (existing.config.privateFeeds) {
            const feedConfig = loadFeedConfig(globalSettingsStore);
            if (feedConfig) {
              const feedResult = writeFeedConfigs(sessionHome, feedConfig);
              // Merge feed env vars into the original env so reopen picks them up
              Object.assign(originalEnv, feedResult.env);
              console.log(`[sessions] feed configs rebuilt for reopen id=${id} feeds=${feedConfig.feeds.join(',')}`);
            }
          }

          console.log(`[sessions] rebuilt per-session HOME=${sessionHome} for reopen id=${id}`);
        } catch (err) {
          console.warn('[sessions] Failed to rebuild per-session home dir on reopen:', err);
        }
      }

      const activeSession = await deps.sessionEngine.reopenSession(id);

      eventBus.publish({ sessionId: activeSession.sessionId, type: 'status', status: 'running' });

      res.setHeader('HX-Redirect', '/');
      res.status(200).send('');
    } catch (err) {
      next(err);
    }
  });

  // GET /api/sessions/:id/fork-form — render new-session form pre-filled from an existing session
  router.get('/sessions/:id/fork-form', async (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      const source = store.getSession(id);
      if (source === undefined) {
        res.status(404).send('<div class="badge badge-error">Session not found</div>');
        return;
      }

      // Resolve the current HEAD commit from the source worktree
      let headSha = '';
      try {
        const result = await executeGit(['rev-parse', 'HEAD'], source.worktree.worktreePath);
        headSha = result.stdout.trim();
      } catch {
        // Fall back to the stored headSha if the worktree is gone
        headSha = source.worktree.headSha;
      }

      // Find repo ID by matching barePath
      const repos = repoStore.listRepos();
      const matchedRepo = repos.find((r) => r.barePath === source.config.repoRoot);
      const repoId = matchedRepo?.id ?? '';

      // Resolve credential profile from session_credentials
      const creds = credStore.getBySessionId(id);
      const credentialProfileId = creds?.profileId ?? '';

      const credentialProfiles = credStore.listProfiles();
      const modelConfigs = modelConfigStore.listConfigs();

      // Detect skipPermissions from the stored args
      const skipPermissions = source.config.args?.includes('--dangerously-skip-permissions') ?? false;
      // Default sandbox to true (matching form default)
      const sandbox = true;
      // Default web access to true
      const webAccess = true;

      // Pre-fill model config from source session
      const modelConfigId = source.config.modelConfigId ?? '';

      // Pre-fill branch name with -fork suffix
      const forkBranch = `${source.worktree.branch}-fork`;

      const html = eta.render('partials/new-session-form', {
        repos,
        credentialProfiles,
        modelConfigs,
        repoId,
        branch: forkBranch,
        sourceBranch: headSha,
        credentialProfileId,
        modelConfigId,
        sandbox,
        skipPermissions,
        webAccess,
        privateFeeds: source.config.privateFeeds ?? false,
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      console.error(`[sessions] fork-form failed for session ${req.params['id']}:`, err);
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

      const worktreePath = existing.worktree.worktreePath;
      const worktreeSessionId = basename(worktreePath);
      const isAdmin = existing.config.repoRoot === '__admin__';

      // Safety-net history capture before cleanup
      if (!existing.historyCapturedAt && !isAdmin) {
        const homeDir = existing.config.env?.['HOME'] ?? join('/tmp', `orcha-home-${worktreeSessionId}`);
        if (existsSync(homeDir)) {
          try {
            const { captureSessionHistory } = await import('../../history/capture.js');
            const { getStoragePaths } = await import('../../storage/paths.js');
            captureSessionHistory(id, homeDir, getStoragePaths().dataDir);
          } catch { /* best-effort */ }
        }
      }

      if (isAdmin) {
        // Admin session: clean up workspace + admin HOME dirs (no git worktree)
        try { rmSync(worktreePath, { recursive: true, force: true }); } catch { /* best-effort */ }
        const adminHomeDir = existing.config.env?.['HOME'];
        if (adminHomeDir) {
          try { rmSync(adminHomeDir, { recursive: true, force: true }); } catch { /* best-effort */ }
        }
      } else {
        // Clean up worktree on disk before removing the DB record
        try {
          await deps.worktreeManager.removeWorktree(worktreeSessionId);
        } catch {
          // Best-effort: worktree may already be gone
        }

        // Clean up the git branch so the name can be reused
        try {
          await deps.worktreeManager.deleteBranch(existing.worktree.branch, existing.config.repoRoot);
        } catch {
          // Best-effort: branch may already be gone or have been merged
        }

        // Clean up per-session isolated HOME dir
        try {
          rmSync(join('/tmp', `orcha-home-${worktreeSessionId}`), { recursive: true, force: true });
        } catch {
          // Best-effort
        }
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
      // Build barePath → displayName / deployCommand maps for repo resolution
      const repoNameMap = new Map<string, string>();
      const deployCmdMap = new Map<string, string>();
      for (const repo of repoStore.listRepos()) {
        if (repo.barePath !== null) {
          repoNameMap.set(repo.barePath, repo.displayName);
          if (repo.deployCommand) {
            deployCmdMap.set(repo.barePath, repo.deployCommand);
          }
        }
      }
      const sessionTaskMap = taskStore.getSessionTaskMap();
      const viewModels = sessions.map((s) => {
        const active = deps.sessionEngine.getSessionByDbId(s.id);
        return toViewModel(s, credStore.getBySessionId(s.id), active?.modelProvider, repoNameMap.get(s.config.repoRoot), deployCmdMap.get(s.config.repoRoot), sessionTaskMap.get(s.id));
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
      const repo = repoStore.getRepoByBarePath(session.config.repoRoot);
      const sessionTaskMap = taskStore.getSessionTaskMap();
      const html = eta.render('partials/session-card', toViewModel(session, creds, active?.modelProvider, repo?.displayName, repo?.deployCommand, sessionTaskMap.get(id)));
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
      // Auto-dismiss with staggered Enters.
      if (active.modelProvider === 'max') {
        active.authCodeSentAt = Date.now();
        const delays = [1000, 2500, 4000, 5500];
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
        // Session exited or not found — 286 tells HTMX to stop polling
        res.status(286).send('');
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
              // 286 tells HTMX to stop polling — auth is resolved
              res.status(286).send(html);
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
        res.status(286).send(html);
        return;
      }

      // Compute session age early — used by multiple checks below.
      const ageMs = Date.now() - active.createdAt.getTime();

      // Tier 2: Check terminal output for login URL
      const snapshot = active.outputBuffer.snapshot();
      const authUrl = extractAuthUrl(snapshot);
      // Strip ANSI escape codes so welcome-text regex works on PTY output.
      const text = stripAnsi(snapshot.toString('utf8'));
      const claudeStarted = /Welcome to|Claude Code v\d|(?:Opus|Sonnet|Haiku)\s+\d/i.test(text);

      if (authUrl) {
        // If Claude Code already started (refresh token worked), the URL
        // is stale — auth succeeded without user interaction.
        if (claudeStarted) {
          const html = eta.render('partials/session-auth-banner', { authenticated: true });
          res.status(286).send(html);
          return;
        }

        // After 30s the auth window is over — any URL in the buffer is from
        // the agent's working output (e.g. DevOps/GitHub links), not a login
        // prompt. The "Welcome to" text may have scrolled out of the buffer.
        if (ageMs > 30_000) {
          res.status(286).send('');
          return;
        }

        const html = eta.render('partials/session-auth-banner', { authenticated: false, authUrl, sessionId: id });
        res.status(200).send(html);
        return;
      }

      // No URL found yet — check if we can stop polling early

      // If Claude Code already started (prompt visible), auth is fine — stop polling
      if (claudeStarted) {
        res.status(286).send('');
        return;
      }

      if (ageMs > 60_000 && active.terminal.exitCode !== undefined) {
        // Session exited without auth URL — stop polling
        res.status(286).send('');
        return;
      }

      // After 30s with no URL and session still alive, auth likely succeeded
      // without needing user interaction (existing refresh token worked)
      if (ageMs > 30_000) {
        res.status(286).send('');
        return;
      }

      // Still in early startup — return empty to keep polling without showing a banner
      res.status(200).send('');
    } catch (err) {
      next(err);
    }
  });

  // ── Markdown browser endpoints ─────────────────────────────────────────

  /** Recursively collect *.md files up to a max depth, relative to root. */
  const MD_SKIP_DIRS = new Set(['node_modules', 'vendor', 'dist', '__pycache__', '.venv', 'venv']);

  function collectMdFiles(root: string, dir: string, depth: number, max: number): string[] {
    if (depth > 4) return [];
    const results: string[] = [];
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return []; }
    for (const entry of entries) {
      if (results.length >= max) break;
      if (entry.startsWith('.') && entry !== '.claude') continue;
      if (MD_SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        results.push(...collectMdFiles(root, full, depth + 1, max - results.length));
      } else if (st.isFile() && extname(entry).toLowerCase() === '.md') {
        results.push(relative(root, full));
      }
    }
    return results;
  }

  /** Validate a user-supplied relative path resolves inside the worktree. */
  function validateMdPath(worktreePath: string, userPath: string): string | null {
    if (!userPath || userPath.includes('\0')) return null;
    const resolved = resolve(worktreePath, userPath);
    if (!resolved.startsWith(worktreePath + '/') && resolved !== worktreePath) return null;
    if (!resolved.endsWith('.md')) return null;
    return resolved;
  }

  const MD_MAX_BYTES = 512 * 1024; // 512KB

  // GET /api/sessions/:id/md-browser — render the markdown browser modal
  router.get('/sessions/:id/md-browser', (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      const session = store.getSession(id);
      if (!session) { res.status(404).send(''); return; }

      const worktreePath = session.worktree.worktreePath;
      if (!existsSync(worktreePath)) {
        res.status(404).send('<div class="badge badge-error">Worktree not found</div>');
        return;
      }

      const files = collectMdFiles(worktreePath, worktreePath, 0, 100);
      // Sort: CLAUDE.md first, then alphabetical
      files.sort((a, b) => {
        const aIsClaudeMd = a === 'CLAUDE.md' || a === '.claude/CLAUDE.md';
        const bIsClaudeMd = b === 'CLAUDE.md' || b === '.claude/CLAUDE.md';
        if (aIsClaudeMd && !bIsClaudeMd) return -1;
        if (!aIsClaudeMd && bIsClaudeMd) return 1;
        return a.localeCompare(b);
      });

      // Auto-select first file (CLAUDE.md if present)
      let initialContent = '';
      let initialRaw = '';
      let initialFile = '';
      if (files.length > 0) {
        initialFile = files[0]!;
        const absPath = resolve(worktreePath, initialFile);
        try {
          initialRaw = readFileSync(absPath, 'utf8').slice(0, MD_MAX_BYTES);
          initialContent = marked.parse(initialRaw) as string;
        } catch { /* empty */ }
      }

      const html = eta.render('partials/md-browser', {
        sessionId: id,
        files,
        initialFile,
        initialContent,
        initialRaw,
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/sessions/:id/md-file?path=README.md — render a single markdown file
  router.get('/sessions/:id/md-file', (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      const userPath = typeof req.query['path'] === 'string' ? req.query['path'] : '';
      const session = store.getSession(id);
      if (!session) { res.status(404).send(''); return; }

      const worktreePath = session.worktree.worktreePath;
      const absPath = validateMdPath(worktreePath, userPath);
      if (!absPath) {
        res.status(400).send('<div class="badge badge-error">Invalid path</div>');
        return;
      }

      if (!existsSync(absPath)) {
        res.status(404).send('<div class="badge badge-error">File not found</div>');
        return;
      }

      const raw = readFileSync(absPath, 'utf8').slice(0, MD_MAX_BYTES);
      const rendered = marked.parse(raw) as string;

      const html = eta.render('partials/md-file-view', {
        sessionId: id,
        filePath: userPath,
        rendered,
        raw,
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/sessions/:id/md-file — save edited markdown content
  router.put('/sessions/:id/md-file', (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      const userPath = typeof req.body['path'] === 'string' ? req.body['path'] : '';
      const content = typeof req.body['content'] === 'string' ? req.body['content'] : '';
      const session = store.getSession(id);
      if (!session) { res.status(404).send(''); return; }

      const worktreePath = session.worktree.worktreePath;
      const absPath = validateMdPath(worktreePath, userPath);
      if (!absPath) {
        res.status(400).send('<div class="badge badge-error">Invalid path</div>');
        return;
      }

      if (content.length > MD_MAX_BYTES) {
        res.status(413).send('<div class="badge badge-error">File too large</div>');
        return;
      }

      writeFileSync(absPath, content, 'utf8');
      const rendered = marked.parse(content) as string;

      const html = eta.render('partials/md-file-view', {
        sessionId: id,
        filePath: userPath,
        rendered,
        raw: content,
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // ── File browser endpoints ──────────────────────────────────────────

  const FILE_SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', '.next', '.nuxt']);
  const FILE_MAX_BYTES = 2 * 1024 * 1024; // 2MB
  const FILE_MAX_ENTRIES = 500;

  /** Validate a user-supplied relative path resolves inside the worktree. */
  function validateFilePath(worktreePath: string, userPath: string): string | null {
    if (!userPath || userPath.includes('\0')) return null;
    const resolved = resolve(worktreePath, userPath);
    if (!resolved.startsWith(worktreePath + '/') && resolved !== worktreePath) return null;
    // Catch symlink escapes
    try {
      const real = realpathSync(resolved);
      if (!real.startsWith(worktreePath + '/') && real !== worktreePath) return null;
    } catch {
      // File might not exist yet (for new file saves) — allow if resolve passed
    }
    return resolved;
  }

  /** Detect binary content by checking for null bytes in the first 8KB. */
  function isBinaryBuffer(buf: Buffer): boolean {
    const check = buf.subarray(0, 8192);
    return check.includes(0);
  }

  /** Map file extension to a CodeMirror language hint. */
  function extToLanguage(ext: string): string {
    const map: Record<string, string> = {
      '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
      '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
      '.jsx': 'jsx', '.tsx': 'tsx',
      '.py': 'python',
      '.html': 'html', '.htm': 'html',
      '.css': 'css', '.scss': 'css',
      '.json': 'json',
      '.md': 'markdown', '.mdx': 'markdown',
      '.sql': 'sql',
      '.yaml': 'yaml', '.yml': 'yaml',
      '.xml': 'xml', '.svg': 'xml',
      '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
      '.rs': 'rust',
      '.go': 'go',
      '.java': 'java',
      '.rb': 'ruby',
      '.php': 'php',
      '.c': 'c', '.h': 'c',
      '.cpp': 'cpp', '.hpp': 'cpp', '.cc': 'cpp',
    };
    return map[ext.toLowerCase()] ?? 'text';
  }

  // GET /api/sessions/:id/file-browser — render the file browser modal
  router.get('/sessions/:id/file-browser', (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      const session = store.getSession(id);
      if (!session) { res.status(404).send(''); return; }

      const worktreePath = session.worktree.worktreePath;
      if (!existsSync(worktreePath)) {
        res.status(404).send('<div class="badge badge-error">Worktree not found</div>');
        return;
      }

      const html = eta.render('partials/file-browser', { sessionId: id });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/sessions/:id/files?path=. — list directory entries
  router.get('/sessions/:id/files', (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      const userPath = typeof req.query['path'] === 'string' ? req.query['path'] : '.';
      const depth = parseInt(typeof req.query['depth'] === 'string' ? req.query['depth'] : '0', 10) || 0;
      const session = store.getSession(id);
      if (!session) { res.status(404).send(''); return; }

      const worktreePath = session.worktree.worktreePath;
      const absPath = validateFilePath(worktreePath, userPath);
      if (!absPath) {
        res.status(400).send('<div class="badge badge-error">Invalid path</div>');
        return;
      }

      let st;
      try { st = statSync(absPath); } catch {
        res.status(404).send('<div class="badge badge-error">Directory not found</div>');
        return;
      }
      if (!st.isDirectory()) {
        res.status(400).send('<div class="badge badge-error">Not a directory</div>');
        return;
      }

      let entries: string[];
      try { entries = readdirSync(absPath); } catch {
        res.status(500).send('<div class="badge badge-error">Cannot read directory</div>');
        return;
      }

      interface FileEntry { name: string; isDirectory: boolean; size: number; extension: string; }
      const items: FileEntry[] = [];

      for (const entry of entries) {
        if (items.length >= FILE_MAX_ENTRIES) break;
        if (entry.startsWith('.') && entry !== '.claude') continue;
        if (FILE_SKIP_DIRS.has(entry)) continue;

        const full = join(absPath, entry);
        let entryStat;
        try { entryStat = statSync(full); } catch { continue; }

        items.push({
          name: entry,
          isDirectory: entryStat.isDirectory(),
          size: entryStat.isDirectory() ? 0 : entryStat.size,
          extension: entryStat.isDirectory() ? '' : extname(entry),
        });
      }

      // Sort: directories first, then alphabetical
      items.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });

      const relPath = relative(worktreePath, absPath) || '.';
      const html = eta.render('partials/file-tree', { sessionId: id, entries: items, dirPath: relPath, depth });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/sessions/:id/file-content?path=<file> — read file content
  router.get('/sessions/:id/file-content', (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      const userPath = typeof req.query['path'] === 'string' ? req.query['path'] : '';
      const session = store.getSession(id);
      if (!session) { res.status(404).json({ error: 'Session not found' }); return; }

      const worktreePath = session.worktree.worktreePath;
      const absPath = validateFilePath(worktreePath, userPath);
      if (!absPath) {
        res.status(400).json({ error: 'Invalid path' });
        return;
      }

      let st;
      try { st = statSync(absPath); } catch {
        res.status(404).json({ error: 'File not found' });
        return;
      }

      if (st.isDirectory()) {
        res.status(400).json({ error: 'Path is a directory' });
        return;
      }

      if (st.size > FILE_MAX_BYTES) {
        res.status(413).json({ error: 'File too large', size: st.size, maxSize: FILE_MAX_BYTES });
        return;
      }

      const buf = readFileSync(absPath);
      if (isBinaryBuffer(buf)) {
        res.json({ binary: true, path: userPath, size: st.size });
        return;
      }

      const content = buf.toString('utf8');
      const ext = extname(absPath);
      res.json({ content, path: userPath, size: st.size, language: extToLanguage(ext) });
    } catch (err) {
      next(err);
    }
  });

  // PUT /api/sessions/:id/file-content — save file content
  router.put('/sessions/:id/file-content', (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      const userPath = typeof req.body['path'] === 'string' ? req.body['path'] : '';
      const content = typeof req.body['content'] === 'string' ? req.body['content'] : '';
      const session = store.getSession(id);
      if (!session) { res.status(404).json({ error: 'Session not found' }); return; }

      const worktreePath = session.worktree.worktreePath;
      const absPath = validateFilePath(worktreePath, userPath);
      if (!absPath) {
        res.status(400).json({ error: 'Invalid path' });
        return;
      }

      if (content.length > FILE_MAX_BYTES) {
        res.status(413).json({ error: 'Content too large' });
        return;
      }

      writeFileSync(absPath, content, 'utf8');
      res.json({ ok: true, path: userPath });
    } catch (err) {
      next(err);
    }
  });

  // ── Diff browser endpoints ────────────────────────────────────────────

  /** Regex for allowed git ref characters. */
  const GIT_REF_RE = /^[a-zA-Z0-9/_.\-]+$/;

  /** Validate a base ref string (branch/tag name). */
  function validateBaseRef(ref: string): string | null {
    if (!ref || !GIT_REF_RE.test(ref) || ref.includes('..')) return null;
    return ref;
  }

  /** Validate a file path for diff (no null bytes, no ..). */
  function validateDiffPath(p: string): string | null {
    if (!p || p.includes('\0') || p.includes('..')) return null;
    return p;
  }

  // GET /api/sessions/:id/diff-browser — render the diff browser overlay
  router.get('/sessions/:id/diff-browser', async (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      const session = store.getSession(id);
      if (!session) { res.status(404).send(''); return; }

      const wt = session.worktree.worktreePath;
      if (!existsSync(wt)) {
        res.status(404).send('<div class="badge badge-error">Worktree not found</div>');
        return;
      }

      // Fetch latest remote refs before listing branches (best-effort)
      try {
        await executeGit(['fetch', '--prune', '--quiet'], wt);
      } catch {
        // Network unavailable or no remote — continue with local refs
      }

      // Discover branches
      let branches: string[] = [];
      try {
        const { stdout } = await executeGit(
          ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin/'],
          wt,
        );
        branches = stdout.trim().split('\n').filter(Boolean);
      } catch {
        // No remotes — that's OK
      }

      // Determine default base ref: the branch the worktree was created from
      const sessionBranch = session.worktree.branch;
      let defaultBase = 'origin/main';
      // Try origin/<branch>, fall back to origin/main, then first available
      if (branches.includes(`origin/${sessionBranch}`)) {
        defaultBase = `origin/${sessionBranch}`;
      } else if (branches.includes('origin/main')) {
        defaultBase = 'origin/main';
      } else if (branches.includes('origin/master')) {
        defaultBase = 'origin/master';
      } else if (branches.length > 0) {
        defaultBase = branches[0]!;
      }

      const html = eta.render('partials/diff-browser', {
        sessionId: id,
        branches,
        defaultBase,
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/sessions/:id/diff/files?base= — file list partial
  router.get('/sessions/:id/diff/files', async (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      const base = validateBaseRef(typeof req.query['base'] === 'string' ? req.query['base'] : '');
      if (!base) { res.status(400).send('Invalid base ref'); return; }

      const session = store.getSession(id);
      if (!session) { res.status(404).send(''); return; }
      const wt = session.worktree.worktreePath;

      // Get numstat (+/- per file)
      let numstatLines: string[] = [];
      try {
        const { stdout } = await executeGit(['diff', '--numstat', `${base}...HEAD`], wt);
        numstatLines = stdout.trim().split('\n').filter(Boolean);
      } catch { /* empty diff */ }

      // Get name-status (A/M/D/R per file)
      let statusLines: string[] = [];
      try {
        const { stdout } = await executeGit(['diff', '--name-status', `${base}...HEAD`], wt);
        statusLines = stdout.trim().split('\n').filter(Boolean);
      } catch { /* empty diff */ }

      // Build file list
      interface DiffFile {
        path: string;
        status: string; // A, M, D, R
        added: number;
        deleted: number;
      }
      const statusMap = new Map<string, string>();
      for (const line of statusLines) {
        const parts = line.split('\t');
        const st = parts[0]?.[0] ?? 'M';
        const filePath = parts[parts.length - 1] ?? '';
        if (filePath) statusMap.set(filePath, st);
      }

      const files: DiffFile[] = [];
      let totalAdded = 0;
      let totalDeleted = 0;
      for (const line of numstatLines) {
        const parts = line.split('\t');
        const added = parseInt(parts[0] ?? '0', 10) || 0;
        const deleted = parseInt(parts[1] ?? '0', 10) || 0;
        const filePath = parts[2] ?? '';
        if (!filePath) continue;
        totalAdded += added;
        totalDeleted += deleted;
        files.push({
          path: filePath,
          status: statusMap.get(filePath) ?? 'M',
          added,
          deleted,
        });
      }

      const html = eta.render('partials/diff-file-list', {
        files,
        totalAdded,
        totalDeleted,
        sessionId: id,
        base,
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/sessions/:id/diff/content?base=&path= — diff content as JSON
  router.get('/sessions/:id/diff/content', async (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      const base = validateBaseRef(typeof req.query['base'] === 'string' ? req.query['base'] : '');
      if (!base) { res.status(400).json({ error: 'Invalid base ref' }); return; }

      const filePath = typeof req.query['path'] === 'string' ? req.query['path'] : '';

      const session = store.getSession(id);
      if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
      const wt = session.worktree.worktreePath;

      const args = ['diff', '--no-color', `${base}...HEAD`];
      if (filePath) {
        const safe = validateDiffPath(filePath);
        if (!safe) { res.status(400).json({ error: 'Invalid file path' }); return; }
        args.push('--', safe);
      }

      let diff = '';
      try {
        const result = await executeGit(args, wt);
        diff = result.stdout;
      } catch {
        // Empty diff or invalid range
      }

      res.json({ diff });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/sessions/:id/diff/commits?base= — commit log as JSON
  router.get('/sessions/:id/diff/commits', async (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      const base = validateBaseRef(typeof req.query['base'] === 'string' ? req.query['base'] : '');
      if (!base) { res.status(400).json({ error: 'Invalid base ref' }); return; }

      const session = store.getSession(id);
      if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
      const wt = session.worktree.worktreePath;

      let count = 0;
      const commits: { sha: string; author: string; date: string; message: string }[] = [];

      try {
        const countResult = await executeGit(['rev-list', '--count', `${base}..HEAD`], wt);
        count = parseInt(countResult.stdout.trim(), 10) || 0;
      } catch { /* no commits */ }

      if (count > 0) {
        try {
          const logResult = await executeGit(
            ['log', '--format=%H|%an|%aI|%s', `${base}..HEAD`],
            wt,
          );
          for (const line of logResult.stdout.trim().split('\n')) {
            if (!line) continue;
            const [sha, author, date, ...rest] = line.split('|');
            commits.push({
              sha: sha ?? '',
              author: author ?? '',
              date: date ?? '',
              message: rest.join('|'),
            });
          }
        } catch { /* ignore */ }
      }

      res.json({ count, commits });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/sessions/:id/diff/branches — list remote branches as JSON
  router.get('/sessions/:id/diff/branches', async (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      const session = store.getSession(id);
      if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
      const wt = session.worktree.worktreePath;

      // Fetch latest remote refs before listing
      try {
        await executeGit(['fetch', '--prune', '--quiet'], wt);
      } catch { /* network unavailable */ }

      let branches: string[] = [];
      try {
        const { stdout } = await executeGit(
          ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin/'],
          wt,
        );
        branches = stdout.trim().split('\n').filter(Boolean);
      } catch { /* no remotes */ }

      res.json({ branches });
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
