import { randomUUID } from 'node:crypto';
import { WorktreeManager } from './worktree-manager.js';
import type { WorktreeInfo } from './worktree-manager.js';
import { PtyManager } from './pty-manager.js';
import type { SessionTerminal, PtySpawnOptions } from './session-terminal.js';
import { OutputBuffer } from './output-buffer.js';
import { SessionStore } from '@orcha/db';

export interface CreateSessionOptions {
  sessionId?: string;
  branch: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  /** Override the repo root used for worktree creation (e.g. a bare repo path). */
  repoRoot?: string;
}

export interface ActiveSession {
  sessionId: string;
  /** The DB row id (UUID) assigned by SessionStore.createSession, used for store updates. */
  dbSessionId: string | undefined;
  worktree: WorktreeInfo;
  terminal: SessionTerminal;
  outputBuffer: OutputBuffer;
  createdAt: Date;
  /** The repo root override used for this session's worktree, if any. */
  repoRoot?: string;
}

export class SessionError extends Error {
  code: 'DUPLICATE_SESSION' | 'WORKTREE_FAILED' | 'PTY_FAILED' | 'NOT_FOUND' | 'STOP_TIMEOUT';
  cause?: unknown;

  constructor(
    message: string,
    code: 'DUPLICATE_SESSION' | 'WORKTREE_FAILED' | 'PTY_FAILED' | 'NOT_FOUND' | 'STOP_TIMEOUT',
    cause?: unknown,
  ) {
    super(message);
    this.name = 'SessionError';
    this.code = code;
    this.cause = cause;
  }
}

export class SessionManager {
  private _active: Map<string, ActiveSession> = new Map();

  constructor(
    private readonly _worktreeManager: WorktreeManager,
    private readonly _ptyManager: PtyManager,
    private readonly _sessionStore: SessionStore,
  ) {}

  async createSession(opts: CreateSessionOptions): Promise<ActiveSession> {
    const sessionId = opts.sessionId ?? randomUUID();

    if (this._active.has(sessionId)) {
      throw new SessionError(
        `Session '${sessionId}' already exists`,
        'DUPLICATE_SESSION',
      );
    }

    // Step 1: Create worktree
    let worktree: WorktreeInfo;
    try {
      worktree = await this._worktreeManager.addWorktree(sessionId, opts.branch, opts.repoRoot);
    } catch (err) {
      throw new SessionError(
        `Failed to create worktree for session '${sessionId}': ${String(err)}`,
        'WORKTREE_FAILED',
        err,
      );
    }

    // Step 2: Spawn PTY
    let terminal: SessionTerminal;
    const spawnOpts: PtySpawnOptions = {
      sessionId,
      cwd: worktree.path,
      command: opts.command,
      ...(opts.args !== undefined ? { args: opts.args } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      size: {
        cols: opts.cols ?? 220,
        rows: opts.rows ?? 50,
      },
    };

    try {
      terminal = this._ptyManager.spawn(spawnOpts);
    } catch (err) {
      // Rollback: remove the worktree we just created
      try {
        await this._worktreeManager.removeWorktree(sessionId);
      } catch {
        // Best-effort rollback; ignore errors
      }
      throw new SessionError(
        `Failed to spawn PTY for session '${sessionId}': ${String(err)}`,
        'PTY_FAILED',
        err,
      );
    }

    // Step 3: Set up output buffer
    const outputBuffer = new OutputBuffer();
    terminal.output.on('data', (chunk: Buffer | string) => {
      outputBuffer.push(chunk);
    });

    // Step 4: Persist to DB
    // Map terminal WorktreeInfo to domain WorktreeInfo for the store.
    // The store generates its own UUID for the DB row; capture it so we can
    // use it in subsequent updateStatus / updateSession calls.
    let dbSessionId: string | undefined;
    try {
      const dbSession = this._sessionStore.createSession(
        {
          instanceId: sessionId,
          repoRoot: worktree.path,
          branch: worktree.branch,
          worktreePath: worktree.path,
          prompt: '',
          env: opts.env ?? {},
          maxRuntimeSeconds: 0,
        },
        {
          worktreePath: worktree.path,
          branch: worktree.branch,
          headSha: worktree.commitSha,
          repoRoot: worktree.path,
          createdAt: worktree.createdAt,
        },
      );
      dbSessionId = dbSession.id;
      // Transition to starting → running
      this._sessionStore.updateStatus(dbSessionId, 'starting');
      this._sessionStore.updateStatus(dbSessionId, 'running');
    } catch {
      // Best-effort: if DB operations fail, the session is still active in memory
    }

    // Step 5: Build ActiveSession record
    const activeSession: ActiveSession = {
      sessionId,
      dbSessionId,
      worktree,
      terminal,
      outputBuffer,
      createdAt: new Date(),
      ...(opts.repoRoot !== undefined ? { repoRoot: opts.repoRoot } : {}),
    };

    this._active.set(sessionId, activeSession);

    // Step 6: Attach exit handler
    terminal.on('exit', (code: number) => {
      void this._handleExit(sessionId, code);
    });

    return activeSession;
  }

  private async _handleExit(sessionId: string, exitCode: number): Promise<void> {
    const session = this._active.get(sessionId);
    this._active.delete(sessionId);

    if (session?.dbSessionId !== undefined) {
      const dbId = session.dbSessionId;
      try {
        this._sessionStore.updateStatus(dbId, 'completed');
        this._sessionStore.updateSession(dbId, { exitCode });
      } catch {
        // Best-effort: session may not exist in DB or transition may be invalid
      }
    }

    try {
      await this._worktreeManager.removeWorktree(sessionId, session?.repoRoot);
    } catch {
      // Best-effort cleanup
    }
  }

  async stopSession(sessionId: string): Promise<void> {
    const session = this._active.get(sessionId);
    if (session === undefined) {
      throw new SessionError(`Session '${sessionId}' not found`, 'NOT_FOUND');
    }

    // Send SIGTERM and wait for exit event or 5s timeout
    session.terminal.kill('SIGTERM');

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        // Fallback to SIGKILL after 5s timeout
        try {
          session.terminal.kill('SIGKILL');
        } catch {
          // Ignore if already dead
        }
        reject(new SessionError(`Stop timed out for session '${sessionId}'`, 'STOP_TIMEOUT'));
      }, 5000);

      session.terminal.on('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  getSession(sessionId: string): ActiveSession | undefined {
    return this._active.get(sessionId);
  }

  listSessions(): ActiveSession[] {
    return Array.from(this._active.values());
  }

  getOutputSnapshot(sessionId: string): Buffer {
    const session = this._active.get(sessionId);
    if (session === undefined) {
      throw new SessionError(`Session '${sessionId}' not found`, 'NOT_FOUND');
    }
    return session.outputBuffer.snapshot();
  }

  async stopAllSessions(): Promise<void> {
    const stopPromises = Array.from(this._active.keys()).map((id) =>
      this.stopSession(id).catch(() => {
        // Suppress individual errors — allSettled semantics
      }),
    );
    await Promise.allSettled(stopPromises);
  }
}
