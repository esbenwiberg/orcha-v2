import type Database from 'better-sqlite3';
import { TaskStore } from '../db/task-store.js';
import { RepoStore } from '../db/repo-store.js';
import { McpServerStore } from '../db/mcp-server-store.js';
import type { SessionManager } from '../terminal/session-manager.js';
import type { Task } from '../domain/task-types.js';
import { investigate } from './investigate.js';
import { enrich } from './enrich.js';
import { execute, waitForSessionExit, extractPrUrl, extractPreviewUrl } from './execute.js';
import { eventBus } from '../web/services/event-bus.js';

export interface TaskProcessorDeps {
  db: Database.Database;
  sessionManager: SessionManager;
}

export class TaskProcessor {
  #taskStore: TaskStore;
  #repoStore: RepoStore;
  #mcpServerStore: McpServerStore;
  #sessionManager: SessionManager;
  #db: Database.Database;
  #interval: ReturnType<typeof setInterval> | undefined;
  #processing = false;

  constructor(deps: TaskProcessorDeps) {
    this.#db = deps.db;
    this.#taskStore = new TaskStore(deps.db);
    this.#repoStore = new RepoStore(deps.db);
    this.#mcpServerStore = new McpServerStore(deps.db);
    this.#sessionManager = deps.sessionManager;
  }

  start(intervalMs = 10_000): void {
    // Run an immediate tick, then schedule
    void this.tick();
    this.#interval = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    if (this.#interval !== undefined) {
      clearInterval(this.#interval);
      this.#interval = undefined;
    }
  }

  async tick(): Promise<void> {
    if (this.#processing) return;
    this.#processing = true;
    try {
      const task = this.#taskStore.getNextActionable();
      if (!task) return;

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
    if (task.autoEnrich) {
      this.#taskStore.transition(task.id, 'investigating', 'Auto-enrich enabled — starting investigation');
      this.#publishStatus(task.id, 'investigating');
      // Re-fetch and run investigation immediately
      const updated = this.#taskStore.getTask(task.id)!;
      await this.#runInvestigation(updated);
    } else {
      this.#taskStore.transition(task.id, 'queued', 'Auto-enrich disabled — skipping to queue');
      this.#publishStatus(task.id, 'queued');
    }
  }

  async #runInvestigation(task: Task): Promise<void> {
    const repo = this.#repoStore.getRepo(task.repoId);
    if (!repo?.barePath) {
      this.#fail(task.id, `Repo '${task.repoId}' not found or not cloned`);
      return;
    }

    try {
      const result = await investigate({
        task,
        taskStore: this.#taskStore,
        cwd: repo.barePath,
      });

      // Rate the result
      if (result.rating === 'reject' || result.rating === 'weak') {
        this.#taskStore.transition(task.id, 'rejected', `Investigation rated: ${result.rating}`);
        this.#publishStatus(task.id, 'rejected');
      } else {
        this.#taskStore.transition(task.id, 'enriching', `Investigation rated: ${result.rating}`);
        this.#publishStatus(task.id, 'enriching');
        // Run enrichment immediately
        const updated = this.#taskStore.getTask(task.id)!;
        await this.#runEnrichment(updated);
      }
    } catch (err) {
      this.#fail(task.id, `Investigation error: ${String(err)}`);
    }
  }

  async #runEnrichment(task: Task): Promise<void> {
    const repo = this.#repoStore.getRepo(task.repoId);
    if (!repo?.barePath) {
      this.#fail(task.id, `Repo '${task.repoId}' not found or not cloned`);
      return;
    }

    try {
      await enrich({
        task,
        taskStore: this.#taskStore,
        cwd: repo.barePath,
      });

      this.#taskStore.transition(task.id, 'queued', 'Enrichment complete — ready for execution');
      this.#publishStatus(task.id, 'queued');
    } catch (err) {
      this.#fail(task.id, `Enrichment error: ${String(err)}`);
    }
  }

  async #runExecution(task: Task): Promise<void> {
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
      });

      // Wait for session to complete (non-blocking for the event loop)
      const exitCode = await waitForSessionExit(session);

      // Extract PR URL and preview URL from terminal output
      const prUrl = extractPrUrl(session);
      const previewUrl = task.selfValidate ? extractPreviewUrl(session) : null;

      if (prUrl) {
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
