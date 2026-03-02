import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { WorktreeManager } from './worktree-manager.js';
import type { WorktreeInfo } from './worktree-manager.js';
import { PtyManager } from './pty-manager.js';
import type { SessionTerminal, PtySpawnOptions } from './session-terminal.js';
import { OutputBuffer } from './output-buffer.js';
import { SessionStore } from '@orcha/db';
import { CredentialStore } from '../db/credential-store.js';
import { ModelConfigStore } from '../db/model-config-store.js';
import { credentialManager } from '../credentials/credential-manager.js';
import type { ValidationManager } from '../validation/validation-manager.js';

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
  /** Per-session isolated HOME directory (for Max/Pro OAuth credential injection). */
  homeDir?: string;
  /** Model config ID used for this session (for credential capture). */
  modelConfigId?: string;
  /** Model provider type (e.g. 'max', 'anthropic'). */
  modelProvider?: string;
  /** Remote branch to base the worktree on (e.g. 'origin/main'). */
  sourceBranch?: string;
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
  /** Per-session isolated HOME directory (for credential capture). */
  homeDir?: string;
  /** Model config ID used for this session (for credential capture). */
  modelConfigId?: string;
  /** Model provider type (e.g. 'max', 'anthropic'). */
  modelProvider?: string;
  /** Timestamp when auth code was sent to PTY (for detecting post-auth state). */
  authCodeSentAt?: number;
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

  private _validationManager?: ValidationManager;

  constructor(
    private readonly _worktreeManager: WorktreeManager,
    private readonly _ptyManager: PtyManager,
    private readonly _sessionStore: SessionStore,
    private readonly _credentialStore?: CredentialStore,
    private readonly _instanceId: string = 'local',
    private readonly _modelConfigStore?: ModelConfigStore,
  ) {}

  setValidationManager(vm: ValidationManager): void {
    this._validationManager = vm;
  }

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
      worktree = await this._worktreeManager.addWorktree(sessionId, opts.branch, opts.repoRoot, opts.sourceBranch);
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

        // Max/Pro sessions with per-session HOME: auto-dismiss first-run prompts.
        // Claude shows a theme picker then a "makes mistakes" disclaimer on first
        // run even with theme set in settings.json. Send Enter twice with staggered
        // delays to dismiss both.
        if (opts.modelProvider === 'max') {
          setTimeout(() => {
            try { terminal.write('\r'); } catch { /* may have exited */ }
            console.log(`[session] auto-dismiss #1 (theme) sessionId=${sessionId}`);
          }, 600);
          setTimeout(() => {
            try { terminal.write('\r'); } catch { /* may have exited */ }
            console.log(`[session] auto-dismiss #2 (disclaimer) sessionId=${sessionId}`);
          }, 2000);
        }
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
          ...(opts.args !== undefined ? { args: opts.args } : {}),
          ...(opts.deleteEnv !== undefined ? { deleteEnv: opts.deleteEnv } : {}),
          ...(opts.modelConfigId !== undefined ? { modelConfigId: opts.modelConfigId } : {}),
          ...(opts.modelProvider !== undefined ? { modelProvider: opts.modelProvider } : {}),
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
      ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
      ...(opts.modelConfigId !== undefined ? { modelConfigId: opts.modelConfigId } : {}),
      ...(opts.modelProvider !== undefined ? { modelProvider: opts.modelProvider } : {}),
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
        this._sessionStore.updateStatus(dbId, exitCode === 0 ? 'completed' : 'failed');
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

    // Tear down any running validation environment for this session
    if (this._validationManager && session?.dbSessionId) {
      this._validationManager.stop(session.dbSessionId).catch((err) => {
        console.warn(`[session] validation teardown failed sessionId=${sessionId}:`, err);
      });
    }

    // Capture refreshed credentials before cleaning up the home dir (Tier 3).
    // Compare file content to stored config — if different, Claude refreshed tokens.
    if (session?.homeDir && session.modelConfigId && this._modelConfigStore) {
      try {
        const credsPath = join(session.homeDir, '.claude', '.credentials.json');
        if (existsSync(credsPath)) {
          const credsJson = readFileSync(credsPath, 'utf8');
          const current = this._modelConfigStore.getConfig(session.modelConfigId);
          if (current?.credentialsJson !== credsJson) {
            this._modelConfigStore.updateConfig(session.modelConfigId, { credentialsJson: credsJson });
            console.log(`[session] captured credentials at exit sessionId=${sessionId} modelConfigId=${session.modelConfigId}`);
          }
        }
      } catch (err) {
        console.warn(`[session] credential capture failed sessionId=${sessionId}:`, err);
      }
    }

    // Worktrees and per-session HOME dirs are now preserved until the session
    // is explicitly deleted, so users can reopen failed/cancelled sessions.
  }

  async reopenSession(dbSessionId: string, opts?: { sandbox?: boolean }): Promise<ActiveSession> {
    // Step 1: Look up the DB session
    const dbSession = this._sessionStore.getSession(dbSessionId);
    if (dbSession === undefined) {
      throw new SessionError(`Session '${dbSessionId}' not found`, 'NOT_FOUND');
    }

    if (dbSession.status !== 'failed' && dbSession.status !== 'cancelled' && dbSession.status !== 'completed') {
      throw new SessionError(
        `Cannot reopen session in '${dbSession.status}' state`,
        'NOT_FOUND',
      );
    }

    // Step 2: Extract worktree path and original sessionId
    const worktreePath = dbSession.worktree.worktreePath;
    const sessionId = basename(worktreePath);

    // Verify worktree directory exists
    if (!existsSync(worktreePath)) {
      throw new SessionError(
        `Worktree directory no longer exists: ${worktreePath}`,
        'WORKTREE_FAILED',
      );
    }

    // Check not already active
    if (this._active.has(sessionId)) {
      throw new SessionError(
        `Session '${sessionId}' is already active`,
        'DUPLICATE_SESSION',
      );
    }

    // Step 3: Restore original args and env (no --continue; the Claude session is likely dead)
    const originalArgs = dbSession.config.args ?? [];
    const reopenArgs = [...originalArgs];
    const originalEnv = dbSession.config.env ?? {};
    const homeDir = originalEnv['HOME'];
    const modelConfigId = dbSession.config.modelConfigId;
    const modelProvider = dbSession.config.modelProvider;

    // Step 4: Spawn PTY in existing worktree with full context
    let terminal: SessionTerminal;
    const spawnOpts: PtySpawnOptions = {
      sessionId,
      cwd: worktreePath,
      command: 'claude',
      args: reopenArgs,
      env: originalEnv,
      size: { cols: 220, rows: 50 },
      ...(opts?.sandbox !== undefined ? { sandbox: opts.sandbox } : {}),
      ...(dbSession.config.deleteEnv !== undefined ? { deleteEnv: dbSession.config.deleteEnv } : {}),
    };

    try {
      terminal = this._ptyManager.spawn(spawnOpts);
    } catch (err) {
      throw new SessionError(
        `Failed to spawn PTY for reopened session '${sessionId}': ${String(err)}`,
        'PTY_FAILED',
        err,
      );
    }

    // Step 5: Set up output buffer + exit handler
    const outputBuffer = new OutputBuffer();
    outputBuffer.push('\r\n\x1b[33mReopening session...\x1b[0m\r\n');
    let firstChunkLogged = false;
    terminal.output.on('data', (chunk: Buffer | string) => {
      outputBuffer.push(chunk);
      if (!firstChunkLogged) {
        firstChunkLogged = true;
        // Max/Pro sessions: auto-dismiss first-run prompts on reopen too
        if (modelProvider === 'max') {
          setTimeout(() => {
            try { terminal.write('\r'); } catch { /* may have exited */ }
          }, 600);
          setTimeout(() => {
            try { terminal.write('\r'); } catch { /* may have exited */ }
          }, 2000);
        }
      }
    });

    // Step 6: Transition status and clear stale data
    try {
      this._sessionStore.resetForReopen(dbSessionId);
      this._sessionStore.updateStatus(dbSessionId, 'starting');
      this._sessionStore.updateStatus(dbSessionId, 'running');
    } catch (err) {
      console.error('[session-manager] DB status transition failed for reopen', dbSessionId, err);
    }

    // Step 7: Build ActiveSession and add to active map
    const worktreeInfo: WorktreeInfo = {
      id: sessionId,
      path: worktreePath,
      branch: dbSession.worktree.branch,
      commitSha: dbSession.worktree.headSha,
      createdAt: dbSession.worktree.createdAt,
    };

    const activeSession: ActiveSession = {
      sessionId,
      dbSessionId,
      worktree: worktreeInfo,
      terminal,
      outputBuffer,
      createdAt: new Date(),
      ...(homeDir !== undefined ? { homeDir } : {}),
      ...(modelConfigId !== undefined ? { modelConfigId } : {}),
      ...(modelProvider !== undefined ? { modelProvider } : {}),
    };

    this._active.set(sessionId, activeSession);

    terminal.on('exit', (code: number) => {
      void this._handleExit(sessionId, code);
    });

    return activeSession;
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
