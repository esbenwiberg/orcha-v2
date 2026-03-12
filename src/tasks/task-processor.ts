import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { captureSessionHistory } from '../history/capture.js';
import type Database from 'better-sqlite3';
import { TaskStore } from '../db/task-store.js';
import { SessionStore } from '../db/session-store.js';
import { RepoStore } from '../db/repo-store.js';
import { McpServerStore } from '../db/mcp-server-store.js';
import { ModelConfigStore } from '../db/model-config-store.js';
import { GlobalSettingsStore } from '../db/global-settings-store.js';
import { buildModelEnv, ENV_DELETE } from '../model-config/env-builder.js';
import { CredentialStore } from '../db/credential-store.js';
import { credentialManager } from '../credentials/credential-manager.js';
import { readSettingsFromDb } from '../web/routes/claude-settings-db.js';
import { buildSessionClaudeMd } from '../web/routes/claude-files.js';
import { loadSkills } from '../web/routes/skills.js';
import { getStoragePaths } from '../storage/paths.js';
import type { SessionManager } from '../terminal/session-manager.js';
import type { WorktreeManager, WorktreeInfo } from '../terminal/worktree-manager.js';
import type { Task } from '../domain/task-types.js';
import { investigate } from './investigate.js';
import { enrich } from './enrich.js';
import { execute, waitForSessionExit, extractPrUrl, extractPreviewUrl } from './execute.js';
import { resolveOrchaHost } from '../host-url.js';
import { eventBus } from '../web/services/event-bus.js';

export interface TaskProcessorDeps {
  db: Database.Database;
  sessionManager: SessionManager;
  worktreeManager: WorktreeManager;
}

/** Slugify a task title into a git branch name. */
function slugifyBranch(title: string): string {
  return (
    'task/' +
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60)
  );
}

export class TaskProcessor {
  #taskStore: TaskStore;
  #repoStore: RepoStore;
  #mcpServerStore: McpServerStore;
  #modelConfigStore: ModelConfigStore;
  #globalSettingsStore: GlobalSettingsStore;
  #credentialStore: CredentialStore;
  #sessionManager: SessionManager;
  #worktreeManager: WorktreeManager;
  #db: Database.Database;
  #interval: ReturnType<typeof setInterval> | undefined;
  #activeTasks = new Set<string>();

  constructor(deps: TaskProcessorDeps) {
    this.#db = deps.db;
    this.#taskStore = new TaskStore(deps.db);
    this.#repoStore = new RepoStore(deps.db);
    this.#mcpServerStore = new McpServerStore(deps.db);
    this.#modelConfigStore = new ModelConfigStore(deps.db);
    this.#globalSettingsStore = new GlobalSettingsStore(deps.db);
    this.#credentialStore = new CredentialStore(deps.db);
    this.#sessionManager = deps.sessionManager;
    this.#worktreeManager = deps.worktreeManager;
  }

  start(intervalMs = 10_000): void {
    // Reconcile tasks stuck in active states from a previous container lifecycle.
    // Sessions are reconciled separately by SessionStore, but task status must also
    // be updated so they can be retried.
    this.#reconcileOrphanedTasks();

    console.log('[task-processor] started (interval=%dms)', intervalMs);
    void this.tick();
    this.#interval = setInterval(() => void this.tick(), intervalMs);
  }

  /** Transition tasks stuck in executing/investigating/enriching on startup. */
  #reconcileOrphanedTasks(): void {
    const activeStatuses = ['executing', 'investigating', 'enriching'] as const;
    let failCount = 0;
    let doneCount = 0;
    for (const status of activeStatuses) {
      const tasks = this.#taskStore.listTasks({ status });
      for (const task of tasks) {
        try {
          // If the task was executing and already has a PR URL, it likely
          // completed its work before the container was killed — mark done
          if (status === 'executing' && task.prUrl) {
            this.#taskStore.transition(task.id, 'done', 'Container restarted, but PR was already created — marking done');
            doneCount++;
          } else {
            this.#taskStore.updateTask(task.id, { errorMessage: `Task was in '${status}' state when the container restarted` });
            this.#taskStore.transition(task.id, 'failed', `Orphaned in '${status}' — container restarted`);
            failCount++;
          }
        } catch {
          // Transition may fail if state doesn't allow it
        }
      }
    }
    if (failCount > 0) console.log('[task-processor] reconciled %d orphaned task(s) → failed', failCount);
    if (doneCount > 0) console.log('[task-processor] reconciled %d orphaned task(s) → done (PR exists)', doneCount);
  }

  stop(): void {
    if (this.#interval !== undefined) {
      clearInterval(this.#interval);
      this.#interval = undefined;
      console.log('[task-processor] stopped');
    }
  }

  async tick(): Promise<void> {
    const max = this.#getMaxConcurrent();

    // Pick up tasks until we hit the concurrent limit
    while (this.#activeTasks.size < max) {
      const excludeIds = [...this.#activeTasks];
      const task = this.#taskStore.getNextActionable(excludeIds.length > 0 ? excludeIds : undefined);
      if (!task) break;

      this.#activeTasks.add(task.id);
      console.log('[task-processor] picked up TASK-%d (%s) status=%s [%d/%d active]',
        task.displayId, task.id.slice(0, 8), task.status, this.#activeTasks.size, max);

      // Fire-and-forget — each task runs independently
      void this.#processTask(task);
    }
  }

  async #processTask(task: Task): Promise<void> {
    try {
      switch (task.status) {
        case 'investigating':
          await this.#runInvestigation(task);
          break;
        case 'enriching':
          await this.#runEnrichment(task);
          break;
        case 'queued':
          await this.#runExecution(task);
          break;
      }
    } catch (err) {
      console.error('[task-processor] tick error:', err);
    } finally {
      this.#activeTasks.delete(task.id);
    }
  }

  /** Read max concurrent tasks from settings (default 1, capped at 10). */
  #getMaxConcurrent(): number {
    const raw = this.#globalSettingsStore.get('max_concurrent_tasks');
    if (!raw) return 1;
    const val = parseInt(raw, 10);
    return Number.isFinite(val) && val >= 1 ? Math.min(val, 10) : 1;
  }

  async #runInvestigation(task: Task): Promise<void> {
    const worktree = await this.#ensureWorktree(task);
    if (!worktree) return;

    const extraEnv = this.#resolveModelEnv(task);
    console.log('[task-processor] TASK-%d investigation starting (cwd=%s hasApiKey=%s)', task.displayId, worktree.path, 'ANTHROPIC_API_KEY' in extraEnv);

    try {
      const result = await investigate({
        task,
        taskStore: this.#taskStore,
        cwd: worktree.path,
        ...(Object.keys(extraEnv).length > 0 ? { extraEnv } : {}),
      });

      this.#persistRefreshedCredentials(task);

      console.log('[task-processor] TASK-%d investigation complete: rating=%s summary=%s',
        task.displayId, result.rating, result.summary.slice(0, 100));

      // Stay in investigating — human reviews the result and decides next step
      // Publish update event so the UI refreshes the card (shows rating badge)
      eventBus.publish({ type: 'task-updated', taskId: task.id });
    } catch (err) {
      this.#fail(task.id, `Investigation error: ${String(err)}`);
    }
  }

  async #runEnrichment(task: Task): Promise<void> {
    const worktree = await this.#ensureWorktree(task);
    if (!worktree) return;

    const extraEnv = this.#resolveModelEnv(task);
    console.log('[task-processor] TASK-%d enrichment starting (cwd=%s)', task.displayId, worktree.path);

    try {
      const result = await enrich({
        task,
        taskStore: this.#taskStore,
        cwd: worktree.path,
        ...(Object.keys(extraEnv).length > 0 ? { extraEnv } : {}),
      });

      this.#persistRefreshedCredentials(task);

      console.log('[task-processor] TASK-%d enrichment complete: complexity=%s files=%d',
        task.displayId, result.complexity, result.affectedFiles.length);

      this.#taskStore.transition(task.id, 'queued', 'Enrichment complete — ready for execution');
      this.#publishStatus(task.id, 'queued');
    } catch (err) {
      this.#fail(task.id, `Enrichment error: ${String(err)}`);
    }
  }

  async #runExecution(task: Task): Promise<void> {
    // Ensure worktree exists (creates or recovers from stale branch/path conflicts)
    const worktree = await this.#ensureWorktree(task);
    if (!worktree) return; // #ensureWorktree already called #fail
    const worktreePath = worktree.path;

    // Generate a stable session ID upfront so the MCP validate URL in settings.json
    // matches the session ID that SessionManager will use (avoids session-not-found errors).
    const sessionId = randomUUID();

    // Build full execution environment (HOME dir, env vars, deleteEnv)
    const { env, deleteEnv, homeDir, modelProvider } = await this.#setupExecutionEnv(task, worktreePath, sessionId);

    console.log('[task-processor] TASK-%d execution starting (worktree=%s hasApiKey=%s hasGhToken=%s homeDir=%s)',
      task.displayId, worktree.path, 'ANTHROPIC_API_KEY' in env, 'GH_TOKEN' in env, homeDir ?? 'none');

    try {
      // Re-read the task before transitioning — guard against the task being
      // cancelled/retried between the time we started setup and now
      const freshTask = this.#taskStore.getTask(task.id);
      if (!freshTask || freshTask.status !== 'queued') {
        console.log('[task-processor] TASK-%d status changed during setup (now=%s) — aborting execution',
          task.displayId, freshTask?.status ?? 'deleted');
        return;
      }

      this.#taskStore.transition(task.id, 'executing', 'Starting execution session');
      this.#publishStatus(task.id, 'executing');

      const orchaHost = resolveOrchaHost();
      const session = await execute({
        task,
        taskStore: this.#taskStore,
        sessionManager: this.#sessionManager,
        repoStore: this.#repoStore,
        mcpServerStore: this.#mcpServerStore,
        db: this.#db,
        sessionId,
        ...(worktree !== undefined ? { existingWorktree: worktree } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(deleteEnv.length > 0 ? { deleteEnv } : {}),
        ...(homeDir !== undefined ? { homeDir } : {}),
        ...(modelProvider !== undefined ? { modelProvider } : {}),
        orchaHost,
      });

      console.log('[task-processor] TASK-%d execution session created: sessionId=%s',
        task.displayId, session.sessionId.slice(0, 8));

      // Wait for session to complete (non-blocking for the event loop)
      const exitCode = await waitForSessionExit(session);

      // Log output buffer size for diagnostics
      const outputSnapshot = session.outputBuffer.snapshot().toString('utf8');
      console.log('[task-processor] TASK-%d execution session exited: code=%d outputBytes=%d',
        task.displayId, exitCode, outputSnapshot.length);

      // Persist refreshed OAuth credentials (if any)
      this.#persistRefreshedCredentials(task);

      // Capture Claude conversation history (best-effort)
      if (homeDir && session.dbSessionId) {
        try {
          const historyResult = captureSessionHistory(
            session.dbSessionId,
            homeDir,
            getStoragePaths().dataDir,
          );
          if (historyResult) {
            new SessionStore(this.#db).updateHistory(session.dbSessionId, historyResult);
            console.log('[task-processor] TASK-%d captured history: messages=%d', task.displayId, historyResult.messageCount);
          }
        } catch (err) {
          console.warn('[task-processor] TASK-%d history capture failed:', task.displayId, err);
        }
      }

      // Detect silent failures — if Claude produced almost no output, it likely
      // failed to start or authenticate (the "Starting claude..." prefix is ~40 chars).
      const STARTING_PREFIX_LEN = 50; // "Starting claude..." + ANSI codes
      if (outputSnapshot.length < STARTING_PREFIX_LEN + 100) {
        const tail = outputSnapshot.replace(/[\x00-\x1f]/g, ' ').trim().slice(-200);
        console.error('[task-processor] TASK-%d silent failure — output too small (%d bytes). Tail: %s',
          task.displayId, outputSnapshot.length, tail);
        this.#fail(task.id, `Execution produced no meaningful output (${outputSnapshot.length} bytes) — Claude likely failed to start or authenticate. Check model config credentials.`);
        return;
      }

      // Extract PR URL and preview URL from terminal output
      const prUrl = extractPrUrl(session);
      const previewUrl = task.selfValidate ? extractPreviewUrl(session) : null;

      if (prUrl) {
        console.log('[task-processor] TASK-%d PR created: %s', task.displayId, prUrl);
        this.#taskStore.setExecution(task.id, { prUrl });
      }
      if (previewUrl) {
        this.#taskStore.setExecution(task.id, { previewUrl });
      }

      if (exitCode === 0) {
        // Clear review feedback after successful execution
        if (task.reviewFeedback) {
          this.#taskStore.setReviewFeedback(task.id, null);
        }
        this.#taskStore.transition(task.id, 'done', `Session exited successfully${prUrl ? ` — PR: ${prUrl}` : ''}`);
        this.#publishStatus(task.id, 'done');
      } else {
        this.#fail(task.id, `Execution session exited with code ${exitCode}`);
      }

      // Keep the session DB record so users can tap into the terminal
      // (live during execution, replay buffer for ~5 min after exit).
      // The session card shows a "Task #N" badge to distinguish it.
    } catch (err) {
      this.#fail(task.id, `Execution error: ${String(err)}`);
    }
  }

  /**
   * Ensures a worktree exists for the task. Creates one if needed, persists
   * the path on the task row, and returns the WorktreeInfo.
   */
  async #ensureWorktree(task: Task): Promise<WorktreeInfo | undefined> {
    // If we have a stored path and it still exists on disk, reuse it
    if (task.worktreePath && existsSync(task.worktreePath)) {
      return this.#resolveWorktree(task);
    }

    // Stored path is stale (e.g. container restart wiped /tmp) — clear it
    if (task.worktreePath) {
      console.warn('[task-processor] TASK-%d stale worktree path %s — recreating', task.displayId, task.worktreePath);
    }

    const repo = this.#repoStore.getRepo(task.repoId);
    if (!repo?.barePath) {
      this.#fail(task.id, `Repo '${task.repoId}' not found or not cloned`);
      return undefined;
    }

    const branch = task.branch || slugifyBranch(task.title);
    const worktreeId = `task-${task.id}`;

    console.log('[task-processor] TASK-%d creating worktree (branch=%s repo=%s)',
      task.displayId, branch, repo.barePath);

    try {
      let worktree: WorktreeInfo;
      try {
        worktree = await this.#worktreeManager.addWorktree(worktreeId, branch, repo.barePath);
      } catch (addErr) {
        // Branch or directory already exists from a previous attempt — clean up and restore
        if (String(addErr).includes('already exists')) {
          console.log('[task-processor] TASK-%d conflict detected, cleaning up stale worktree/branch', task.displayId);

          // 1. Remove stale git worktree entry (may fail if git doesn't track it)
          try {
            await this.#worktreeManager.removeWorktree(worktreeId, repo.barePath);
          } catch { /* not tracked */ }

          // 2. Physically delete the directory — removeWorktree may have failed,
          //    leaving a broken .git reference that blocks restoreWorktree
          const worktreeFsPath = join(getStoragePaths().worktreeBaseDir, worktreeId);
          if (existsSync(worktreeFsPath)) {
            rmSync(worktreeFsPath, { recursive: true, force: true });
          }

          // 3. Try restoring from existing branch (preserves prior commits)
          try {
            worktree = await this.#worktreeManager.restoreWorktree(worktreeId, branch, repo.barePath);
          } catch {
            // restoreWorktree may have left a partial directory — nuke it again
            if (existsSync(worktreeFsPath)) {
              rmSync(worktreeFsPath, { recursive: true, force: true });
            }
            // Branch may not exist — delete it and start fresh
            try { await this.#worktreeManager.deleteBranch(branch, repo.barePath); } catch { /* ignore */ }
            worktree = await this.#worktreeManager.addWorktree(worktreeId, branch, repo.barePath);
          }
        } else {
          throw addErr;
        }
      }

      this.#taskStore.setWorktreePath(task.id, worktree.path);

      // Also persist the branch if it wasn't set
      if (!task.branch) {
        this.#taskStore.updateTask(task.id, { branch });
      }

      console.log('[task-processor] TASK-%d worktree created at %s', task.displayId, worktree.path);
      return worktree;
    } catch (err) {
      this.#fail(task.id, `Worktree creation failed: ${String(err)}`);
      return undefined;
    }
  }

  /** Build WorktreeInfo from a persisted worktree path. */
  async #resolveWorktree(task: Task): Promise<WorktreeInfo | undefined> {
    if (!task.worktreePath) return undefined;

    const repo = this.#repoStore.getRepo(task.repoId);
    const branch = task.branch || slugifyBranch(task.title);

    return {
      id: `task-${task.id}`,
      path: task.worktreePath,
      branch,
      commitSha: '', // Not needed for reuse
      createdAt: task.createdAt,
      ...(repo?.barePath ? {} : {}),
    };
  }

  /**
   * Resolve model config into env vars for the spawned claude process.
   * For API-key providers: sets ANTHROPIC_API_KEY.
   * For Max/Pro (OAuth): creates a temp HOME with .credentials.json so
   * claude --print can authenticate non-interactively.
   */
  #resolveModelEnv(task: Task): Record<string, string> {
    if (!task.modelConfigId) return {};
    const mc = this.#modelConfigStore.getConfig(task.modelConfigId);
    if (!mc) return {};
    const raw = buildModelEnv(mc);
    // Filter out ENV_DELETE sentinels — just omit those keys
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v !== ENV_DELETE) env[k] = v;
    }

    // For Max/Pro OAuth: set up a temp HOME with credentials
    if (mc.credentialsJson) {
      const taskHome = `/tmp/orcha-task-home-${task.id}`;
      const claudeDir = join(taskHome, '.claude');
      mkdirSync(claudeDir, { recursive: true });

      // Write OAuth credentials
      writeFileSync(join(claudeDir, '.credentials.json'), mc.credentialsJson, 'utf8');

      // Seed settings.json (theme=dark to skip first-run picker)
      const sharedSettings = join(homedir(), '.claude', 'settings.json');
      let settings: Record<string, unknown> = { theme: 'dark' };
      if (existsSync(sharedSettings)) {
        try { settings = { ...JSON.parse(readFileSync(sharedSettings, 'utf8')) as Record<string, unknown>, theme: 'dark' }; } catch { /* ignore */ }
      }
      writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(settings), 'utf8');

      // Skip onboarding
      writeFileSync(join(claudeDir, '.config.json'), JSON.stringify({ hasCompletedOnboarding: true }), 'utf8');

      env['HOME'] = taskHome;
      console.log('[task-processor] TASK-%d using OAuth credentials (HOME=%s)', task.displayId, taskHome);
    }

    return env;
  }

  /**
   * Build a full execution environment for the task session, mirroring what
   * the session route does for user-created sessions. This includes:
   * - Model config env vars (API key or OAuth HOME)
   * - Full HOME dir setup: .config.json (MCP, trust, onboarding),
   *   settings.json (permissions, MCP), .credentials.json, .gitconfig,
   *   .git-credentials, CLAUDE.md, skills
   */
  async #setupExecutionEnv(task: Task, worktreePath: string, sessionId: string): Promise<{
    env: Record<string, string>;
    deleteEnv: string[];
    homeDir: string | undefined;
    modelProvider: string | undefined;
  }> {
    const mc = task.modelConfigId ? this.#modelConfigStore.getConfig(task.modelConfigId) : undefined;
    const env: Record<string, string> = {
      ORCHA_SESSION_ID: sessionId,
    };
    const deleteEnv: string[] = [];

    // 0. Repo-level env vars (lowest priority — overridable by credentials + model config)
    const repo = this.#repoStore.getRepo(task.repoId);
    if (repo?.envVars && Object.keys(repo.envVars).length > 0) {
      Object.assign(env, repo.envVars);
    }

    // Apply model config env vars (API key, base URL, etc.)
    if (mc) {
      const raw = buildModelEnv(mc);
      for (const [k, v] of Object.entries(raw)) {
        if (v === ENV_DELETE) {
          deleteEnv.push(k);
        } else {
          env[k] = v;
        }
      }
    }

    // Provision credentials from the credential profile (GitHub PAT, Azure SP, DevOps)
    if (task.credentialProfileId) {
      const profile = this.#credentialStore.getProfile(task.credentialProfileId);
      if (profile) {
        try {
          const { activeCreds, env: credEnv } = await credentialManager.provision(profile);
          Object.assign(env, credEnv);

          // Persist credential grant for auto-revoke on session exit
          this.#credentialStore.createSessionCredentials({
            profileId: profile.id,
            profileName: profile.name,
            ...(activeCreds.azureSpName !== undefined ? { azureSpName: activeCreds.azureSpName } : {}),
            ...(activeCreds.azureAppId !== undefined ? { azureAppId: activeCreds.azureAppId } : {}),
            ...(activeCreds.githubPatId !== undefined ? { githubPatId: activeCreds.githubPatId } : {}),
            ...(activeCreds.devopsPatId !== undefined ? { devopsPatId: activeCreds.devopsPatId } : {}),
            expiresAt: activeCreds.expiresAt,
          });

          console.log('[task-processor] TASK-%d credentials provisioned: profile=%s ghToken=%s',
            task.displayId, profile.name, 'GH_TOKEN' in credEnv);
        } catch (err) {
          console.warn('[task-processor] TASK-%d credential provisioning failed: %s', task.displayId, err);
        }
      }
    }

    // Always create a per-task HOME so we can configure Claude properly
    const taskHome = `/tmp/orcha-task-home-${task.id}`;
    const claudeDir = join(taskHome, '.claude');
    mkdirSync(claudeDir, { recursive: true });

    // 1. Copy host .gitconfig (safe.directory, fileMode settings)
    const srcGitconfig = join(homedir(), '.gitconfig');
    if (existsSync(srcGitconfig)) {
      try { copyFileSync(srcGitconfig, join(taskHome, '.gitconfig')); } catch { /* ignore */ }
    }

    // 2. Append git user identity from global settings
    const gitUserName = this.#globalSettingsStore.get('git.user.name');
    const gitUserEmail = this.#globalSettingsStore.get('git.user.email');
    if (gitUserName || gitUserEmail) {
      let section = '\n[user]\n';
      if (gitUserName) section += `\tname = ${gitUserName}\n`;
      if (gitUserEmail) section += `\temail = ${gitUserEmail}\n`;
      try { appendFileSync(join(taskHome, '.gitconfig'), section); } catch { /* ignore */ }
    }

    // 3. Generate .git-credentials from env (GH_TOKEN for git push)
    const ghToken = env['GH_TOKEN'] ?? env['GITHUB_TOKEN'];
    if (ghToken) {
      writeFileSync(join(taskHome, '.git-credentials'), `https://oauth2:${ghToken}@github.com\n`);
    }

    // 4. Build settings.json with permissions, theme, MCP servers
    const settings: Record<string, unknown> = readSettingsFromDb(this.#globalSettingsStore);
    if (!('theme' in settings)) settings['theme'] = 'dark';

    // Build MCP servers map
    const mcpServers: Record<string, unknown> = {};
    if (task.mcpServerIds.length > 0) {
      const entries = this.#mcpServerStore.getSettingsEntries(task.mcpServerIds);
      Object.assign(mcpServers, entries);
    }
    // Inject built-in MCP servers — use the pre-generated sessionId so the
    // validate endpoint can look up the session in the DB.
    const orchaHost = resolveOrchaHost();
    mcpServers['validate'] = {
      type: 'http',
      url: `${orchaHost}/mcp/validate/${sessionId}`,
    };
    mcpServers['orcha'] = {
      type: 'http',
      url: `${orchaHost}/mcp/orcha`,
    };
    mcpServers['messages'] = {
      type: 'http',
      url: `${orchaHost}/mcp/messages/${sessionId}`,
    };
    settings['mcpServers'] = mcpServers;
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(settings), 'utf8');

    // 5. Build .config.json — MCP servers, trust, onboarding, API key fingerprints
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
    if (mc?.apiKey) {
      const keyFingerprint = mc.apiKey.slice(-20);
      claudeConfig['customApiKeyResponses'] = { approved: [keyFingerprint], rejected: [] };
    }
    writeFileSync(join(claudeDir, '.config.json'), JSON.stringify(claudeConfig), 'utf8');

    // 6. Write CLAUDE.md (merged with soul.md)
    const mergedClaudeMd = buildSessionClaudeMd(this.#globalSettingsStore);
    if (mergedClaudeMd) writeFileSync(join(claudeDir, 'CLAUDE.md'), mergedClaudeMd, 'utf8');

    // 7. Write skills
    const skills = loadSkills(this.#globalSettingsStore);
    for (const skill of skills) {
      const skillDir = join(claudeDir, 'skills', skill.name);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), skill.content, 'utf8');
    }

    // 8. Write OAuth credentials if available
    if (mc?.credentialsJson) {
      writeFileSync(join(claudeDir, '.credentials.json'), mc.credentialsJson, 'utf8');
    }

    env['HOME'] = taskHome;
    env['DOTNET_CLI_HOME'] = taskHome;

    // If repo/credential env vars set PATH, merge with (don't replace) the
    // system PATH — otherwise tools like npm, node, git become unfindable.
    if (env['PATH']) {
      const systemPath = process.env['PATH'] ?? '';
      env['PATH'] = `${env['PATH']}:${systemPath}`;
    }

    console.log('[task-processor] TASK-%d execution HOME=%s mcpServers=%s hasCredentials=%s',
      task.displayId, taskHome, Object.keys(mcpServers).join(','), !!mc?.credentialsJson);

    return {
      env,
      deleteEnv,
      homeDir: taskHome,
      modelProvider: mc?.provider,
    };
  }

  /**
   * After a spawn completes, read back the credentials file from the temp HOME.
   * Claude CLI may have refreshed the OAuth token (rotating the refresh token),
   * so we persist the updated credentials to the DB to avoid 401s after restart.
   */
  #persistRefreshedCredentials(task: Task): void {
    if (!task.modelConfigId) return;
    const mc = this.#modelConfigStore.getConfig(task.modelConfigId);
    if (!mc?.credentialsJson) return;

    const credsPath = join(`/tmp/orcha-task-home-${task.id}`, '.claude', '.credentials.json');
    try {
      if (!existsSync(credsPath)) return;
      const updated = readFileSync(credsPath, 'utf8');
      if (updated && updated !== mc.credentialsJson) {
        this.#modelConfigStore.updateConfig(task.modelConfigId, { credentialsJson: updated });
        console.log('[task-processor] TASK-%d persisted refreshed OAuth credentials', task.displayId);
      }
    } catch (err) {
      console.warn('[task-processor] TASK-%d failed to persist refreshed credentials: %s', task.displayId, err);
    }
  }

  #fail(taskId: string, message: string): void {
    console.error(`[task-processor] task ${taskId}: ${message}`);
    try {
      this.#taskStore.updateTask(taskId, { errorMessage: message });
      this.#taskStore.transition(taskId, 'failed', message);
    } catch {
      // Task may already be in a terminal state
    }
    this.#publishStatus(taskId, 'failed');
  }

  #publishStatus(taskId: string, status: string): void {
    eventBus.publish({ type: 'task-status', taskId, status });
  }
}
