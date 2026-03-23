import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
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
import type { SessionValidateConfig } from '@orcha/domain';
import { captureSessionHistory } from '../history/capture.js';
import type { StatusMonitor } from './status-monitor.js';
import type { ValidationManager } from '../validation/validation-manager.js';
import { eventBus } from '../web/services/event-bus.js';

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
  /** Whether to enable landlock filesystem isolation for this session. Defaults to true. Only takes effect when SANDBOX_MODE=landlock. */
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
  /** MCP server IDs selected for this session (from the registry). */
  mcpServerIds?: string[];
  /** Whether private Azure DevOps feeds are enabled for this session. */
  privateFeeds?: boolean;
  /** Pre-existing worktree to reuse (skips worktree creation). */
  existingWorktree?: WorktreeInfo;
  /** Snapshotted validation config (merged repo + preset fields). */
  validateConfig?: SessionValidateConfig;
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
  /** Timestamp when auth was resolved (credential refresh, stale URL, or code accepted).
   *  Used to briefly show the green "Authenticated" banner before resuming idle polling. */
  authResolvedAt?: number;
  /** Spawn context preserved for debug shells to inherit. */
  spawnContext?: {
    env?: Record<string, string>;
    sandbox?: boolean;
    deleteEnv?: string[];
    extraRwPaths?: string[];
  };
  /** Auth URL that the user explicitly dismissed (so we don't re-show the same one). */
  dismissedAuthUrl?: string;
  /** When true, skip validation teardown on exit (let auto-timeout handle it). */
  taskOwned?: boolean;
}

export interface DebugShell {
  shellId: string;
  parentSessionId: string;
  terminal: SessionTerminal;
  outputBuffer: OutputBuffer;
  createdAt: Date;
  /** Display label for reconnection (e.g. 'Host Shell', 'Deploy'). Undefined = plain 'Shell'. */
  label?: string;
}

export class SessionError extends Error {
  code: 'DUPLICATE_SESSION' | 'WORKTREE_FAILED' | 'PTY_FAILED' | 'NOT_FOUND' | 'STOP_TIMEOUT' | 'MAX_SESSIONS';
  cause?: unknown;

  constructor(
    message: string,
    code: 'DUPLICATE_SESSION' | 'WORKTREE_FAILED' | 'PTY_FAILED' | 'NOT_FOUND' | 'STOP_TIMEOUT' | 'MAX_SESSIONS',
    cause?: unknown,
  ) {
    super(message);
    this.name = 'SessionError';
    this.code = code;
    this.cause = cause;
  }
}

/**
 * Default max concurrent sessions. Each Claude Code process uses 200-400 MB
 * of RSS even when idle. On a 3 Gi container this allows ~3 sessions with
 * enough headroom for builds and Orcha itself.
 *
 * Override via MAX_CONCURRENT_SESSIONS env var.
 */
const DEFAULT_MAX_SESSIONS = 4;

export class SessionManager {
  private _active: Map<string, ActiveSession> = new Map();
  private _debugShells: Map<string, DebugShell> = new Map();

  private _validationManager?: ValidationManager;
  private _statusMonitor?: StatusMonitor;
  private readonly _maxSessions: number;

  constructor(
    private readonly _worktreeManager: WorktreeManager,
    private readonly _ptyManager: PtyManager,
    private readonly _sessionStore: SessionStore,
    private readonly _credentialStore?: CredentialStore,
    private readonly _instanceId: string = 'local',
    private readonly _modelConfigStore?: ModelConfigStore,
    private readonly _dataDir?: string,
  ) {
    const envMax = parseInt(process.env['MAX_CONCURRENT_SESSIONS'] ?? '', 10);
    this._maxSessions = Number.isFinite(envMax) && envMax >= 1 ? envMax : DEFAULT_MAX_SESSIONS;
  }

  get maxSessions(): number {
    return this._maxSessions;
  }

  set maxSessions(value: number) {
    this._maxSessions = Math.max(1, value);
  }

  setStatusMonitor(monitor: StatusMonitor): void {
    this._statusMonitor = monitor;
  }

  setValidationManager(vm: ValidationManager): void {
    this._validationManager = vm;
  }

  async createSession(opts: CreateSessionOptions): Promise<ActiveSession> {
    // Count only sessions whose PTY is still running (not exited sessions
    // lingering in the map for late-connecting WebSocket clients).
    const runningSessions = Array.from(this._active.values()).filter(
      (s) => s.terminal.exitCode === undefined,
    ).length;

    if (runningSessions >= this._maxSessions) {
      throw new SessionError(
        `Maximum concurrent sessions reached (${this._maxSessions}). Stop an existing session first.`,
        'MAX_SESSIONS',
      );
    }

    const sessionId = opts.sessionId ?? randomUUID();

    if (this._active.has(sessionId)) {
      throw new SessionError(
        `Session '${sessionId}' already exists`,
        'DUPLICATE_SESSION',
      );
    }

    // Step 1: Create worktree (or reuse an existing one)
    let worktree: WorktreeInfo;
    if (opts.existingWorktree) {
      worktree = opts.existingWorktree;
    } else {
      try {
        worktree = await this._worktreeManager.addWorktree(sessionId, opts.branch, opts.repoRoot, opts.sourceBranch);
      } catch (err) {
        throw new SessionError(
          `Failed to create worktree for session '${sessionId}': ${String(err)}`,
          'WORKTREE_FAILED',
          err,
        );
      }
    }

    // Step 2: Spawn PTY
    let terminal: SessionTerminal;
    // Grant the sandbox RW access to the bare repo so git operations
    // (commit, push) can update refs and write objects through the worktree
    // .git symlink that points back to the bare repo.
    const extraRwPaths: string[] = [];
    if (opts.repoRoot !== undefined && opts.repoRoot !== worktree.path) {
      extraRwPaths.push(opts.repoRoot);
    }

    // Per-session Azure CLI config dir so `az login` inside a sandboxed
    // session writes tokens to /tmp (already RW in landlock) instead of
    // ~/.azure/ (blocked).  Each session gets its own dir — no cross-session
    // credential leakage.
    const azureConfigDir = `/tmp/orcha-azure-${sessionId}`;
    mkdirSync(azureConfigDir, { recursive: true });
    const sessionEnv: Record<string, string> = {
      ...opts.env,
      AZURE_CONFIG_DIR: azureConfigDir,
    };

    const spawnOpts: PtySpawnOptions = {
      sessionId,
      cwd: worktree.path,
      command: opts.command,
      ...(opts.args !== undefined ? { args: opts.args } : {}),
      env: sessionEnv,
      size: {
        cols: opts.cols ?? 220,
        rows: opts.rows ?? 50,
      },
      ...(opts.sandbox !== undefined ? { sandbox: opts.sandbox } : {}),
      ...(opts.deleteEnv !== undefined ? { deleteEnv: opts.deleteEnv } : {}),
      ...(extraRwPaths.length > 0 ? { extraRwPaths } : {}),
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

        // Auto-dismiss disabled — onboarding prompts should be suppressed
        // via hasCompletedOnboarding + theme in .config.json/settings.json.
      }
    });

    // Step 4: Persist to DB
    // Pass sessionId so the DB row uses the same ID as the MCP URL
    // (task-processor pre-generates the ID and embeds it in settings.json).
    let dbSessionId: string | undefined;
    try {
      const dbSession = this._sessionStore.createSession(
        {
          instanceId: this._instanceId,
          repoRoot: opts.repoRoot ?? worktree.path,
          branch: worktree.branch,
          worktreePath: worktree.path,
          prompt: '',
          env: sessionEnv,
          maxRuntimeSeconds: 0,
          ...(opts.args !== undefined ? { args: opts.args } : {}),
          ...(opts.deleteEnv !== undefined ? { deleteEnv: opts.deleteEnv } : {}),
          ...(opts.modelConfigId !== undefined ? { modelConfigId: opts.modelConfigId } : {}),
          ...(opts.modelProvider !== undefined ? { modelProvider: opts.modelProvider } : {}),
          ...(opts.mcpServerIds !== undefined && opts.mcpServerIds.length > 0 ? { mcpServerIds: opts.mcpServerIds } : {}),
          ...(opts.privateFeeds ? { privateFeeds: true } : {}),
          ...(opts.validateConfig !== undefined ? { validateConfig: opts.validateConfig } : {}),
        },
        {
          worktreePath: worktree.path,
          branch: worktree.branch,
          headSha: worktree.commitSha,
          repoRoot: opts.repoRoot ?? worktree.path,
          createdAt: worktree.createdAt,
        },
        sessionId,
      );
      dbSessionId = dbSession.id;
      // Transition to starting → running
      this._sessionStore.updateStatus(dbSessionId, 'starting');
      this._sessionStore.updateStatus(dbSessionId, 'running');
      eventBus.publish({ type: 'status', sessionId: dbSessionId, status: 'running' });
    } catch (err) {
      console.error('[session-manager] DB write failed for session', sessionId, err);
      // Session is still active in memory; DB persistence failed
    }

    // Step 5: Build ActiveSession record
    const spawnContext: ActiveSession['spawnContext'] = {
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(opts.sandbox !== undefined ? { sandbox: opts.sandbox } : {}),
      ...(opts.deleteEnv !== undefined ? { deleteEnv: opts.deleteEnv } : {}),
      ...(extraRwPaths.length > 0 ? { extraRwPaths } : {}),
    };
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
      spawnContext,
    };

    this._active.set(sessionId, activeSession);

    // Step 6: Attach status monitor (if available)
    this._statusMonitor?.watch(sessionId, terminal);

    // Step 7: Attach exit handler
    terminal.on('exit', (code: number) => {
      void this._handleExit(sessionId, code);
    });

    return activeSession;
  }

  private async _handleExit(sessionId: string, exitCode: number): Promise<void> {
    console.log(`[session] exit sessionId=${sessionId} exitCode=${exitCode}`);
    this._statusMonitor?.unwatch(sessionId);
    const session = this._active.get(sessionId);
    // Keep session accessible for 5 min after exit so a WS that connects late
    // can still read the output buffer (e.g. sandbox failing immediately).
    setTimeout(() => this._active.delete(sessionId), 5 * 60 * 1000);

    if (session?.dbSessionId !== undefined) {
      const dbId = session.dbSessionId;
      const exitStatus = exitCode === 0 ? 'completed' : 'failed';
      try {
        this._sessionStore.updateStatus(dbId, exitStatus);
        this._sessionStore.updateSession(dbId, { exitCode });
      } catch {
        // Best-effort: session may not exist in DB or transition may be invalid
      }
      eventBus.publish({ type: 'status', sessionId: dbId, status: exitStatus });

      // Auto-revoke credentials tied to this session (best-effort)
      if (this._credentialStore) {
        const activeCreds = this._credentialStore.getBySessionId(dbId);
        if (activeCreds && !activeCreds.revokedAt) {
          credentialManager.revoke(activeCreds).catch(() => {});
          this._credentialStore.markRevoked(activeCreds.id);
        }
      }
    }

    // Tear down any running validation environment for this session.
    // For task-owned sessions, skip teardown — let the validation auto-timeout
    // handle it so previews remain accessible for review after task completion.
    if (this._validationManager && session?.dbSessionId && !session.taskOwned) {
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

    // Capture Claude conversation history (best-effort)
    if (session?.homeDir && session.dbSessionId && this._dataDir) {
      try {
        const repoRoot = session.repoRoot ?? session.worktree.path;
        const repoName = repoRoot.split('/').pop() ?? 'unknown';
        const result = captureSessionHistory(
          session.dbSessionId, session.homeDir, this._dataDir,
          { repoName, branch: session.worktree.branch },
        );
        if (result) {
          this._sessionStore.updateHistory(session.dbSessionId, result);
          console.log(`[session] captured history sessionId=${sessionId} messages=${result.messageCount}`);
        }
      } catch (err) {
        console.warn(`[session] history capture failed sessionId=${sessionId}:`, err);
      }
    }

    // Kill any debug shells attached to this session
    for (const shell of this._debugShells.values()) {
      if (shell.parentSessionId === sessionId) {
        shell.terminal.kill('SIGTERM');
        this._debugShells.delete(shell.shellId);
      }
    }

    // Worktrees and per-session HOME dirs are now preserved until the session
    // is explicitly deleted, so users can reopen failed/cancelled sessions.
  }

  async reopenSession(dbSessionId: string, opts?: { sandbox?: boolean }): Promise<ActiveSession> {
    const runningSessions = Array.from(this._active.values()).filter(
      (s) => s.terminal.exitCode === undefined,
    ).length;
    if (runningSessions >= this._maxSessions) {
      throw new SessionError(
        `Maximum concurrent sessions reached (${this._maxSessions}). Stop an existing session first.`,
        'MAX_SESSIONS',
      );
    }

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
    let worktreePath = dbSession.worktree.worktreePath;
    const sessionId = basename(worktreePath);

    // Restore worktree if missing (e.g. container restarted, /tmp cleared)
    if (!existsSync(worktreePath)) {
      try {
        const restored = await this._worktreeManager.restoreWorktree(
          sessionId,
          dbSession.worktree.branch,
          dbSession.worktree.repoRoot,
        );
        // If restored to a different path (migration from /data/worktrees to /tmp),
        // update DB so future reopens use the new location
        if (restored.path !== worktreePath) {
          this._sessionStore.updateWorktreePath(dbSessionId, restored.path);
        }
        worktreePath = restored.path;
      } catch (err) {
        throw new SessionError(
          `Failed to restore worktree for session '${sessionId}': ${String(err)}`,
          'WORKTREE_FAILED',
          err,
        );
      }
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

    // Re-create per-session Azure CLI config dir (may have been lost on restart)
    const azCfg = originalEnv['AZURE_CONFIG_DIR'];
    if (azCfg) {
      mkdirSync(azCfg, { recursive: true });
    }
    const modelConfigId = dbSession.config.modelConfigId;
    const modelProvider = dbSession.config.modelProvider;

    // Step 4: Spawn PTY in existing worktree with full context
    // Grant sandbox RW access to the bare repo (same as createSession)
    const repoRoot = dbSession.worktree.repoRoot;
    const extraRwPaths: string[] = [];
    if (repoRoot !== undefined && repoRoot !== worktreePath) {
      extraRwPaths.push(repoRoot);
    }

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
      ...(extraRwPaths.length > 0 ? { extraRwPaths } : {}),
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
    terminal.output.on('data', (chunk: Buffer | string) => {
      outputBuffer.push(chunk);
    });

    // Step 6: Transition status and clear stale data
    try {
      this._sessionStore.resetForReopen(dbSessionId);
      this._sessionStore.updateStatus(dbSessionId, 'starting');
      this._sessionStore.updateStatus(dbSessionId, 'running');
      eventBus.publish({ type: 'status', sessionId: dbSessionId, status: 'running' });
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

    const reopenSpawnContext: ActiveSession['spawnContext'] = {
      ...(originalEnv !== undefined ? { env: originalEnv } : {}),
      ...(opts?.sandbox !== undefined ? { sandbox: opts.sandbox } : {}),
      ...(dbSession.config.deleteEnv !== undefined ? { deleteEnv: dbSession.config.deleteEnv } : {}),
      ...(extraRwPaths.length > 0 ? { extraRwPaths } : {}),
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
      spawnContext: reopenSpawnContext,
    };

    this._active.set(sessionId, activeSession);

    this._statusMonitor?.watch(sessionId, terminal);

    terminal.on('exit', (code: number) => {
      void this._handleExit(sessionId, code);
    });

    return activeSession;
  }

  async createAdminSession(opts: {
    workspaceDir: string;
    homeDir: string;
    prompt?: string;
    args?: string[];
    env?: Record<string, string>;
    deleteEnv?: string[];
    modelConfigId?: string;
    modelProvider?: string;
  }): Promise<ActiveSession> {
    const sessionId = randomUUID();

    const env: Record<string, string> = {
      HOME: opts.homeDir,
      ...opts.env,
    };

    const spawnArgs = opts.args ?? [];
    if (opts.prompt) {
      spawnArgs.push('-p', opts.prompt);
    }

    let terminal: SessionTerminal;
    try {
      terminal = this._ptyManager.spawn({
        sessionId,
        cwd: opts.workspaceDir,
        command: 'claude',
        args: spawnArgs,
        env,
        size: { cols: 220, rows: 50 },
        sandbox: false,
        ...(opts.deleteEnv !== undefined ? { deleteEnv: opts.deleteEnv } : {}),
      });
    } catch (err) {
      throw new SessionError(
        `Failed to spawn admin session: ${String(err)}`,
        'PTY_FAILED',
        err,
      );
    }

    const outputBuffer = new OutputBuffer();
    outputBuffer.push('\r\n\x1b[33mStarting admin session...\x1b[0m\r\n');
    terminal.output.on('data', (chunk: Buffer | string) => {
      outputBuffer.push(chunk);
    });

    // Persist to DB with sentinel repoRoot
    let dbSessionId: string | undefined;
    try {
      const dbSession = this._sessionStore.createSession(
        {
          instanceId: this._instanceId,
          repoRoot: '__admin__',
          branch: 'admin-history-analysis',
          worktreePath: opts.workspaceDir,
          prompt: opts.prompt ?? '',
          env,
          maxRuntimeSeconds: 0,
          ...(opts.modelConfigId !== undefined ? { modelConfigId: opts.modelConfigId } : {}),
          ...(opts.modelProvider !== undefined ? { modelProvider: opts.modelProvider } : {}),
        },
        {
          worktreePath: opts.workspaceDir,
          branch: 'admin-history-analysis',
          headSha: '',
          repoRoot: '__admin__',
          createdAt: new Date(),
        },
        sessionId,
      );
      dbSessionId = dbSession.id;
      this._sessionStore.updateStatus(dbSessionId, 'starting');
      this._sessionStore.updateStatus(dbSessionId, 'running');
      eventBus.publish({ type: 'status', sessionId: dbSessionId, status: 'running' });
    } catch (err) {
      console.error('[session-manager] DB write failed for admin session', sessionId, err);
    }

    const activeSession: ActiveSession = {
      sessionId,
      dbSessionId,
      worktree: {
        id: sessionId,
        path: opts.workspaceDir,
        branch: 'admin-history-analysis',
        commitSha: '',
        createdAt: new Date(),
      },
      terminal,
      outputBuffer,
      createdAt: new Date(),
      homeDir: opts.homeDir,
      ...(opts.modelConfigId !== undefined ? { modelConfigId: opts.modelConfigId } : {}),
      ...(opts.modelProvider !== undefined ? { modelProvider: opts.modelProvider } : {}),
    };

    this._active.set(sessionId, activeSession);
    this._statusMonitor?.watch(sessionId, terminal);

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
    // Kill all debug shells first
    for (const shell of this._debugShells.values()) {
      shell.terminal.kill('SIGTERM');
    }
    this._debugShells.clear();

    const stopPromises = Array.from(this._active.keys()).map((id) =>
      this.stopSession(id).catch(() => {
        // Suppress individual errors — allSettled semantics
      }),
    );
    await Promise.allSettled(stopPromises);
  }

  // --- Debug shell management ---

  spawnDebugShell(parentSessionId: string, opts?: { command?: string; args?: string[] }): DebugShell {
    // Look up parent by memory sessionId or DB id
    const parent = this._active.get(parentSessionId) ?? this.getSessionByDbId(parentSessionId);
    if (parent === undefined) {
      throw new SessionError(`Parent session '${parentSessionId}' not found`, 'NOT_FOUND');
    }

    const shellId = `shell-${randomUUID()}`;
    const ctx = parent.spawnContext ?? {};

    const spawnOpts: PtySpawnOptions = {
      sessionId: shellId,
      cwd: parent.worktree.path,
      command: opts?.command ?? 'bash',
      ...(opts?.args !== undefined ? { args: opts.args } : {}),
      ...(ctx.env !== undefined ? { env: ctx.env } : {}),
      size: { cols: 220, rows: 50 },
      ...(ctx.sandbox !== undefined ? { sandbox: ctx.sandbox } : {}),
      ...(ctx.deleteEnv !== undefined ? { deleteEnv: ctx.deleteEnv } : {}),
      ...(ctx.extraRwPaths !== undefined ? { extraRwPaths: ctx.extraRwPaths } : {}),
    };

    const terminal = this._ptyManager.spawn(spawnOpts);
    const outputBuffer = new OutputBuffer();
    terminal.output.on('data', (chunk: Buffer | string) => {
      outputBuffer.push(chunk);
    });

    const shell: DebugShell = {
      shellId,
      parentSessionId: parent.sessionId,
      terminal,
      outputBuffer,
      createdAt: new Date(),
    };

    terminal.on('exit', () => {
      this._debugShells.delete(shellId);
    });

    this._debugShells.set(shellId, shell);
    return shell;
  }

  /**
   * Spawn a sandboxed shell in the session's worktree with the host's
   * environment + session-scoped AZURE_CONFIG_DIR.
   *
   * Use case: Claude writes scripts, operator runs them with their own
   * credentials. `az login` inside the shell writes to /tmp (session-scoped)
   * so all CLI auth is cleaned up when the session closes.
   */
  spawnHostShell(parentSessionId: string, opts?: { extraEnv?: Record<string, string>; command?: string[]; label?: string }): DebugShell {
    const parent = this._active.get(parentSessionId) ?? this.getSessionByDbId(parentSessionId);
    if (parent === undefined) {
      throw new SessionError(`Parent session '${parentSessionId}' not found`, 'NOT_FOUND');
    }

    const shellId = `shell-${randomUUID()}`;
    const ctx = parent.spawnContext ?? {};

    // Host shells use the host's Azure CLI config (~/.azure), not the
    // per-session /tmp dir. No AZURE_CONFIG_DIR override needed — az falls
    // back to ~/.azure which the Dockerfile pre-creates as writable.
    const env: Record<string, string> = {
      ...opts?.extraEnv,
    };

    // If a command is provided (e.g. deploy script), run it via bash -c.
    // Otherwise open an interactive bash shell.
    const command = 'bash';
    const args = opts?.command ? ['-c', opts.command.join(' ')] : undefined;

    // Grant landlock RW access to ~/.azure so `az login` can write tokens
    const hostAzureDir = join(homedir(), '.azure');
    const extraRwPaths = [...(ctx.extraRwPaths ?? []), hostAzureDir];

    const spawnOpts: PtySpawnOptions = {
      sessionId: shellId,
      cwd: parent.worktree.path,
      command,
      ...(args !== undefined ? { args } : {}),
      env,
      size: { cols: 220, rows: 50 },
      ...(ctx.sandbox !== undefined ? { sandbox: ctx.sandbox } : {}),
      extraRwPaths,
      // No deleteEnv — don't strip host vars
    };

    const terminal = this._ptyManager.spawn(spawnOpts);
    const outputBuffer = new OutputBuffer();
    terminal.output.on('data', (chunk: Buffer | string) => {
      outputBuffer.push(chunk);
    });

    const shell: DebugShell = {
      shellId,
      parentSessionId: parent.sessionId,
      terminal,
      outputBuffer,
      createdAt: new Date(),
      ...(opts?.label !== undefined ? { label: opts.label } : {}),
    };

    terminal.on('exit', () => {
      this._debugShells.delete(shellId);
    });

    this._debugShells.set(shellId, shell);
    return shell;
  }

  getDebugShell(shellId: string): DebugShell | undefined {
    return this._debugShells.get(shellId);
  }

  listDebugShells(parentSessionId: string): DebugShell[] {
    const shells: DebugShell[] = [];
    for (const shell of this._debugShells.values()) {
      if (shell.parentSessionId === parentSessionId) {
        shells.push(shell);
      }
    }
    return shells;
  }

  stopDebugShell(shellId: string): void {
    const shell = this._debugShells.get(shellId);
    if (shell === undefined) {
      throw new SessionError(`Debug shell '${shellId}' not found`, 'NOT_FOUND');
    }
    shell.terminal.kill('SIGTERM');
    this._debugShells.delete(shellId);
  }

  /**
   * Spawn a standalone shell not tied to any session. Used for host-level
   * operations like `az login` from the Settings page.
   *
   * The shell runs with the host environment and grants landlock RW access
   * to ~/.azure so `az login` can write tokens.
   */
  spawnStandaloneShell(opts: {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
  }): DebugShell {
    const shellId = `shell-${randomUUID()}`;
    const hostAzureDir = join(homedir(), '.azure');

    const spawnOpts: PtySpawnOptions = {
      sessionId: shellId,
      cwd: opts.cwd ?? homedir(),
      command: opts.command,
      ...(opts.args !== undefined ? { args: opts.args } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      size: { cols: 220, rows: 50 },
      extraRwPaths: [hostAzureDir],
    };

    const terminal = this._ptyManager.spawn(spawnOpts);
    const outputBuffer = new OutputBuffer();
    terminal.output.on('data', (chunk: Buffer | string) => {
      outputBuffer.push(chunk);
    });

    const shell: DebugShell = {
      shellId,
      parentSessionId: '__standalone__',
      terminal,
      outputBuffer,
      createdAt: new Date(),
    };

    terminal.on('exit', () => {
      this._debugShells.delete(shellId);
    });

    this._debugShells.set(shellId, shell);
    return shell;
  }
}
