import { EventEmitter } from 'node:events';
import { WorktreeManager } from './worktree-manager.js';
import { SessionManager } from './session-manager.js';
import { SessionStore } from '../db/session-store.js';
import { CredentialStore } from '../db/credential-store.js';
import { credentialManager } from '../credentials/credential-manager.js';

export interface CleanupResult {
  scannedAt: Date;
  orphanedWorktreesRemoved: string[];
  staleSessionsMarked: string[];
  errors: Array<{ sessionId: string; error: string }>;
}

export class CleanupService extends EventEmitter {
  private _timer: NodeJS.Timeout | undefined = undefined;

  constructor(
    private readonly _sessionManager: SessionManager,
    private readonly _worktreeManager: WorktreeManager,
    private readonly _sessionStore: SessionStore,
    private readonly _intervalMs: number = 60_000,
    private readonly _credentialStore?: CredentialStore,
  ) {
    super();
  }

  start(): void {
    if (this._timer !== undefined) return;

    // Fire immediately (fire-and-forget)
    this.runOnce().catch(() => {
      // Swallow errors from the initial run
    });

    this._timer = setInterval(() => {
      void this._runCleanup();
    }, this._intervalMs);
  }

  stop(): void {
    if (this._timer !== undefined) {
      clearInterval(this._timer);
      this._timer = undefined;
    }
  }

  async runOnce(): Promise<CleanupResult> {
    const result: CleanupResult = {
      scannedAt: new Date(),
      orphanedWorktreesRemoved: [],
      staleSessionsMarked: [],
      errors: [],
    };

    // --- Step 1: Find stale DB sessions (running in DB but no live PTY) ---
    const allDbSessions = this._sessionStore.listSessions();
    const runningSessions = allDbSessions.filter((s) => s.status === 'running');

    for (const session of runningSessions) {
      // The session manager keyed by instanceId (the sessionId used when creating the session)
      const liveSession = this._sessionManager.getSession(session.instanceId);
      if (liveSession === undefined) {
        // PTY died without cleanup — mark as failed
        try {
          this._sessionStore.updateStatus(session.id, 'failed');
          result.staleSessionsMarked.push(session.id);
        } catch (err) {
          result.errors.push({
            sessionId: session.id,
            error: String(err),
          });
        }
      }
    }

    // --- Step 2: Find orphaned worktrees (on disk but no active DB session) ---
    const fsWorktrees = await this._worktreeManager.listWorktrees();

    // Build a set of worktree paths for ALL DB sessions — worktrees are now
    // preserved until the session is deleted so users can reopen failed/cancelled ones.
    const activeWorktreePaths = new Set<string>(
      allDbSessions.map((s) => s.worktree.worktreePath),
    );

    for (const worktree of fsWorktrees) {
      if (!activeWorktreePaths.has(worktree.path)) {
        // Orphaned — attempt removal
        try {
          await this._worktreeManager.removeWorktree(worktree.id);
          result.orphanedWorktreesRemoved.push(worktree.path);
        } catch (err) {
          result.errors.push({
            sessionId: worktree.id,
            error: String(err),
          });
        }
      }
    }

    // --- Step 3: Revoke expired credentials ---
    if (this._credentialStore) {
      const expired = this._credentialStore.listExpired();
      for (const creds of expired) {
        try {
          await credentialManager.revoke(creds);
          this._credentialStore.markRevoked(creds.id);
        } catch (err) {
          result.errors.push({
            sessionId: creds.sessionId ?? creds.id,
            error: `credential revoke: ${String(err)}`,
          });
        }
      }
    }

    return result;
  }

  private async _runCleanup(): Promise<void> {
    try {
      const result = await this.runOnce();
      this.emit('cleanup-complete', result);
    } catch (err) {
      this.emit('cleanup-error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  // TypeScript event overloads
  on(event: 'cleanup-complete', listener: (result: CleanupResult) => void): this;
  on(event: 'cleanup-error', listener: (err: Error) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }
}
