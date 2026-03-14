import { EventEmitter } from 'node:events';
import { WorktreeManager } from './worktree-manager.js';
import { SessionManager } from './session-manager.js';
import { SessionStore } from '../db/session-store.js';
import { CredentialStore } from '../db/credential-store.js';
import { credentialManager } from '../credentials/credential-manager.js';
import type { ValidationManager } from '../validation/validation-manager.js';
import { eventBus } from '../web/services/event-bus.js';

export interface CleanupResult {
  scannedAt: Date;
  orphanedWorktreesRemoved: string[];
  staleSessionsMarked: string[];
  errors: Array<{ sessionId: string; error: string }>;
}

export class CleanupService extends EventEmitter {
  private _timer: NodeJS.Timeout | undefined = undefined;

  private _validationManager?: ValidationManager;

  constructor(
    private readonly _sessionManager: SessionManager,
    private readonly _worktreeManager: WorktreeManager,
    private readonly _sessionStore: SessionStore,
    private readonly _intervalMs: number = 60_000,
    private readonly _credentialStore?: CredentialStore,
  ) {
    super();
  }

  setValidationManager(vm: ValidationManager): void {
    this._validationManager = vm;
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
          eventBus.publish({ type: 'status', sessionId: session.id, status: 'failed' });
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
    // Uses a filesystem scan of the worktrees directory instead of git commands.
    // This is more robust than `git worktree list` which requires a single valid
    // repo root — Orcha manages multiple bare repos.
    const fsWorktreeDirs = this._worktreeManager.listWorktreeDirsOnDisk();

    // Build a set of worktree paths for ALL DB sessions — worktrees are now
    // preserved until the session is deleted so users can reopen failed/cancelled ones.
    const activeWorktreePaths = new Set<string>(
      allDbSessions.map((s) => s.worktree.worktreePath),
    );

    let removedOrphans = false;
    for (const dir of fsWorktreeDirs) {
      if (!activeWorktreePaths.has(dir.path)) {
        // Orphaned — remove directory
        try {
          this._worktreeManager.removeOrphanedWorktreeDir(dir.id);
          result.orphanedWorktreesRemoved.push(dir.path);
          removedOrphans = true;
        } catch (err) {
          result.errors.push({
            sessionId: dir.id,
            error: String(err),
          });
        }
      }
    }
    // Prune stale git worktree references across all bare repos (once, after all removals)
    if (removedOrphans) {
      try {
        await this._worktreeManager.pruneAllBareRepos();
      } catch {
        // Best-effort
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

    // --- Step 4: Sweep orphaned validation docker projects ---
    if (this._validationManager) {
      const activeSessionIds = new Set(allDbSessions.filter((s) => s.status === 'running').map((s) => s.id));
      try {
        await this._validationManager.cleanup(activeSessionIds);
      } catch (err) {
        result.errors.push({
          sessionId: 'validation-cleanup',
          error: String(err),
        });
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
