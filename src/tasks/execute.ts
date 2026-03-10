import type { Task } from '../domain/task-types.js';
import type { TaskStore } from '../db/task-store.js';
import type { SessionManager, ActiveSession } from '../terminal/session-manager.js';
import type { WorktreeInfo } from '../terminal/worktree-manager.js';
import type { RepoStore } from '../db/repo-store.js';
import { McpServerStore } from '../db/mcp-server-store.js';
import { buildExecutionPrompt } from './prompts.js';
import { eventBus } from '../web/services/event-bus.js';

export interface ExecuteContext {
  task: Task;
  taskStore: TaskStore;
  sessionManager: SessionManager;
  repoStore: RepoStore;
  mcpServerStore: McpServerStore;
  db: import('better-sqlite3').Database;
  /** Pre-existing worktree to reuse (from investigation/enrichment). */
  existingWorktree?: WorktreeInfo;
  /** Extra env vars for the session (API key, HOME, etc. from model config). */
  env?: Record<string, string>;
  /** Env keys to delete from the spawned process (e.g. unset ANTHROPIC_API_KEY for OAuth). */
  deleteEnv?: string[];
  /** Per-session isolated HOME directory (for OAuth credential injection). */
  homeDir?: string;
  /** Model provider type (e.g. 'max', 'anthropic'). */
  modelProvider?: string;
  /** Pre-generated session ID (must match the ID used in MCP URL setup). */
  sessionId?: string;
  /** External Orcha host URL (e.g. https://orcha.example.com) for PR links. */
  orchaHost?: string;
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

export async function execute(ctx: ExecuteContext): Promise<ActiveSession> {
  const { task, taskStore, sessionManager, repoStore } = ctx;

  // Resolve repo to get the bare repo path
  const repo = repoStore.getRepo(task.repoId);
  if (!repo) {
    throw new Error(`Repo '${task.repoId}' not found`);
  }

  const branch = task.branch || slugifyBranch(task.title);
  const prompt = buildExecutionPrompt(task, {
    ...(ctx.orchaHost !== undefined ? { orchaHost: ctx.orchaHost } : {}),
  });

  // Build claude args: non-interactive with the prompt
  const args = [
    '--dangerously-skip-permissions',
    '--verbose',
    '-p',
    prompt,
  ];

  // Resolve MCP server IDs to settings entries
  const mcpServerIds = task.mcpServerIds.length > 0 ? task.mcpServerIds : undefined;

  // Create the session via SessionManager (handles worktree, PTY, DB record)
  const session = await sessionManager.createSession({
    ...(ctx.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
    branch,
    command: 'claude',
    args,
    ...(repo.barePath !== null ? { repoRoot: repo.barePath } : {}),
    sandbox: false, // Task sessions need full access for git push, gh pr create
    ...(mcpServerIds !== undefined ? { mcpServerIds } : {}),
    ...(task.modelConfigId ? { modelConfigId: task.modelConfigId } : {}),
    ...(ctx.existingWorktree !== undefined ? { existingWorktree: ctx.existingWorktree } : {}),
    ...(ctx.env !== undefined ? { env: ctx.env } : {}),
    ...(ctx.deleteEnv !== undefined ? { deleteEnv: ctx.deleteEnv } : {}),
    ...(ctx.homeDir !== undefined ? { homeDir: ctx.homeDir } : {}),
    ...(ctx.modelProvider !== undefined ? { modelProvider: ctx.modelProvider } : {}),
  });

  // Mark as task-owned so validation env survives session exit
  session.taskOwned = true;

  // Store execution metadata on the task
  taskStore.setExecution(task.id, {
    sessionId: session.dbSessionId ?? session.sessionId,
    branch,
  });

  // Publish status update
  eventBus.publish({
    type: 'task-status',
    taskId: task.id,
    status: 'executing',
  });

  return session;
}

/** Default execution timeout: 30 minutes. */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Listen for a session to exit and resolve/reject accordingly.
 * Returns the exit code when the session's PTY exits.
 *
 * Handles the race where the PTY may have already exited before we attach
 * the listener (exitCode is already set). Also enforces a timeout so the
 * task processor doesn't hang forever on a stuck session.
 */
export function waitForSessionExit(
  session: ActiveSession,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    // If the terminal already exited before we started listening, resolve immediately
    if (session.terminal.exitCode !== undefined) {
      resolve(session.terminal.exitCode);
      return;
    }

    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        // Kill the session so it doesn't linger
        try { session.terminal.kill(); } catch { /* best-effort */ }
        reject(new Error(`Execution timed out after ${Math.round(timeoutMs / 60_000)} minutes`));
      }
    }, timeoutMs);

    session.terminal.on('exit', (code: number) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(code);
      }
    });
  });
}

/**
 * Try to extract a PR URL from the session's terminal output buffer.
 * Looks for GitHub/Azure DevOps PR URLs in the output.
 */
export function extractPrUrl(session: ActiveSession): string | null {
  const output = session.outputBuffer.snapshot().toString('utf8');
  // Match GitHub PR URLs
  const ghMatch = output.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
  if (ghMatch) return ghMatch[0];
  // Match Azure DevOps PR URLs
  const adoMatch = output.match(/https:\/\/dev\.azure\.com\/[^\s]+\/pullrequest\/\d+/);
  if (adoMatch) return adoMatch[0];
  return null;
}

/**
 * Try to extract a preview URL from the session's terminal output buffer.
 * Looks for validate_start preview URLs — either full ORCHA_HOST-based URLs
 * (e.g. https://orcha.example.com/validate/{id}/) or relative /validate/ paths.
 */
export function extractPreviewUrl(session: ActiveSession): string | null {
  const output = session.outputBuffer.snapshot().toString('utf8');
  // Full URL with /validate/ path (ORCHA_HOST is set)
  const fullMatch = output.match(/https?:\/\/[^\s"]*\/validate\/[0-9a-f-]+\//i);
  if (fullMatch) return fullMatch[0];
  // Relative /validate/ path (fallback when ORCHA_HOST is not set)
  const relMatch = output.match(/\/validate\/[0-9a-f-]+\//);
  return relMatch ? relMatch[0] : null;
}
