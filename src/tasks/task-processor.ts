import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type Database from 'better-sqlite3';
import { TaskStore } from '../db/task-store.js';
import { RepoStore } from '../db/repo-store.js';
import { McpServerStore } from '../db/mcp-server-store.js';
import { ModelConfigStore } from '../db/model-config-store.js';
import { buildModelEnv, ENV_DELETE } from '../model-config/env-builder.js';
import type { SessionManager } from '../terminal/session-manager.js';
import type { WorktreeManager, WorktreeInfo } from '../terminal/worktree-manager.js';
import type { Task } from '../domain/task-types.js';
import { investigate } from './investigate.js';
import { enrich } from './enrich.js';
import { execute, waitForSessionExit, extractPrUrl, extractPreviewUrl } from './execute.js';
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
  #sessionManager: SessionManager;
  #worktreeManager: WorktreeManager;
  #db: Database.Database;
  #interval: ReturnType<typeof setInterval> | undefined;
  #processing = false;

  constructor(deps: TaskProcessorDeps) {
    this.#db = deps.db;
    this.#taskStore = new TaskStore(deps.db);
    this.#repoStore = new RepoStore(deps.db);
    this.#mcpServerStore = new McpServerStore(deps.db);
    this.#modelConfigStore = new ModelConfigStore(deps.db);
    this.#sessionManager = deps.sessionManager;
    this.#worktreeManager = deps.worktreeManager;
  }

  start(intervalMs = 10_000): void {
    console.log('[task-processor] started (interval=%dms)', intervalMs);
    void this.tick();
    this.#interval = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    if (this.#interval !== undefined) {
      clearInterval(this.#interval);
      this.#interval = undefined;
      console.log('[task-processor] stopped');
    }
  }

  async tick(): Promise<void> {
    if (this.#processing) return;
    this.#processing = true;
    try {
      const task = this.#taskStore.getNextActionable();
      if (!task) return;

      console.log('[task-processor] picked up TASK-%d (%s) status=%s', task.displayId, task.id.slice(0, 8), task.status);

      switch (task.status) {
        case 'draft':
          await this.#handleDraft(task);
          break;
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
      this.#processing = false;
    }
  }

  async #handleDraft(task: Task): Promise<void> {
    // Create worktree up front — shared across investigate, enrich, and execute
    const worktree = await this.#ensureWorktree(task);
    if (!worktree) return; // #ensureWorktree already called #fail

    if (task.autoEnrich) {
      this.#taskStore.transition(task.id, 'investigating', 'Auto-enrich enabled — starting investigation');
      this.#publishStatus(task.id, 'investigating');
      const updated = this.#taskStore.getTask(task.id)!;
      await this.#runInvestigation(updated);
    } else {
      this.#taskStore.transition(task.id, 'queued', 'Auto-enrich disabled — skipping to queue');
      this.#publishStatus(task.id, 'queued');
    }
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

      if (result.rating === 'reject' || result.rating === 'weak') {
        this.#taskStore.transition(task.id, 'rejected', `Investigation rated: ${result.rating}`);
        this.#publishStatus(task.id, 'rejected');
      } else {
        this.#taskStore.transition(task.id, 'enriching', `Investigation rated: ${result.rating}`);
        this.#publishStatus(task.id, 'enriching');
        const updated = this.#taskStore.getTask(task.id)!;
        await this.#runEnrichment(updated);
      }
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
    // Resolve existing worktree (if any) for reuse
    const worktree = task.worktreePath ? await this.#resolveWorktree(task) : undefined;

    console.log('[task-processor] TASK-%d execution starting (worktree=%s)',
      task.displayId, worktree ? worktree.path : 'new');

    try {
      this.#taskStore.transition(task.id, 'executing', 'Starting execution session');
      this.#publishStatus(task.id, 'executing');

      const session = await execute({
        task,
        taskStore: this.#taskStore,
        sessionManager: this.#sessionManager,
        repoStore: this.#repoStore,
        mcpServerStore: this.#mcpServerStore,
        db: this.#db,
        ...(worktree !== undefined ? { existingWorktree: worktree } : {}),
      });

      console.log('[task-processor] TASK-%d execution session created: sessionId=%s',
        task.displayId, session.sessionId.slice(0, 8));

      // Wait for session to complete (non-blocking for the event loop)
      const exitCode = await waitForSessionExit(session);

      console.log('[task-processor] TASK-%d execution session exited: code=%d', task.displayId, exitCode);

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
        this.#taskStore.transition(task.id, 'done', `Session exited successfully${prUrl ? ` — PR: ${prUrl}` : ''}`);
        this.#publishStatus(task.id, 'done');
      } else {
        this.#fail(task.id, `Execution session exited with code ${exitCode}`);
      }
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
        // Branch already exists (e.g. from a previous failed attempt) — restore it
        if (String(addErr).includes('already exists')) {
          console.log('[task-processor] TASK-%d branch exists, restoring worktree', task.displayId);
          worktree = await this.#worktreeManager.restoreWorktree(worktreeId, branch, repo.barePath);
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
