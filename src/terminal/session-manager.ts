import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { WorktreeManager } from './worktree-manager.js';
import type { WorktreeInfo } from './worktree-manager.js';
import { PtyManager } from './pty-manager.js';
import type { SessionTerminal, PtySpawnOptions } from './session-terminal.js';
import { OutputBuffer } from './output-buffer.js';
import { SessionStore } from '@orcha/db';
import { CredentialStore } from '../db/credential-store.js';
import { credentialManager } from '../credentials/credential-manager.js';

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
  /** Whether to enable bwrap filesystem isolation for this session. Defaults to true. Only takes effect when SANDBOX_MODE=bwrap. */
  sandbox?: boolean;
  /** Env keys to explicitly delete from the spawned process environment (overrides process.env). */
  deleteEnv?: string[];
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
    private readonly _credentialStore?: CredentialStore,
    private readonly _instanceId: string = 'local',
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
      ...(opts.sandbox !== undefined ? { sandbox: opts.sandbox } : {}),
      ...(opts.deleteEnv !== undefined ? { deleteEnv: opts.deleteEnv } : {}),
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
    // Pre-fill with a startup notice so the terminal isn't blank while the
    // process initialises (claude takes several seconds to load its bundle).
    outputBuffer.push('\r\n\x1b[33mStarting claude...\x1b[0m\r\n');
    let firstChunkLogged = false;
    terminal.output.on('data', (chunk: Buffer | string) => {
      outputBuffer.push(chunk);
      if (!firstChunkLogged) {
        firstChunkLogged = true;
        const bytes = typeof chunk === 'string' ? chunk.length : chunk.byteLength;
        console.log(`[session] first output chunk sessionId=${sessionId} bytes=${bytes}`);
      }
    });

    // Step 4: Persist to DB
    // Map terminal WorktreeInfo to domain WorktreeInfo for the store.
    // The store generates its own UUID for the DB row; capture it so we can
    // use it in subsequent updateStatus / updateSession calls.
    let dbSessionId: string | undefined;
    try {
      const dbSession = this._sessionStore.createSession(
        {
          instanceId: this._instanceId,
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
    } catch (err) {
      console.error('[session-manager] DB write failed for session', sessionId, err);
      // Session is still active in memory; DB persistence failed
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
    console.log(`[session] exit sessionId=${sessionId} exitCode=${exitCode}`);
    const session = this._active.get(sessionId);
    // Keep session accessible for 5 min after exit so a WS that connects late
    // can still read the output buffer (e.g. bwrap failing immediately).
    setTimeout(() => this._active.delete(sessionId), 5 * 60 * 1000);

    if (session?.dbSessionId !== undefined) {
      const dbId = session.dbSessionId;
      try {
        this._sessionStore.updateStatus(dbId, 'completed');
        this._sessionStore.updateSession(dbId, { exitCode });
      } catch {
        // Best-effort: session may not exist in DB or transition may be invalid
      }

      // Auto-revoke credentials tied to this session (best-effort)
      if (this._credentialStore) {
        const activeCreds = this._credentialStore.getBySessionId(dbId);
        if (activeCreds && !activeCreds.revokedAt) {
          credentialManager.revoke(activeCreds).catch(() => {});
          this._credentialStore.markRevoked(activeCreds.id);
        }
      }
    }

    try {
      await this._worktreeManager.removeWorktree(sessionId, session?.repoRoot);
    } catch {
      // Best-effort cleanup
    }

    // Clean up per-session isolated HOME if one was created.
    try {
      rmSync(join('/tmp', `orcha-home-${sessionId}`), { recursive: true, force: true });
    } catch {
      // Best-effort; directory may not exist for sessions without credentials
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

  getSessionByDbId(dbSessionId: string): ActiveSession | undefined {
    for (const session of this._active.values()) {
      if (session.dbSessionId === dbSessionId) {
        return session;
      }
    }
    return undefined;
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
