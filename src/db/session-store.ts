import Database from 'better-sqlite3';
import type { Session, SessionStatus, SessionConfig, WorktreeInfo } from '@orcha/domain';
import { assertValidTransition } from '@orcha/domain';
import { encryptJson, decryptJson } from '../credentials/crypto.js';

export class SessionStore {
  #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  #rowToSession(row: Record<string, unknown>): Session {
    const startedAt = row['started_at'] as string | null;
    const completedAt = row['completed_at'] as string | null;
    const exitCode = row['exit_code'] as number | null;
    const errorMessage = row['error_message'] as string | null;

    const worktreeRaw = JSON.parse(row['worktree_json'] as string) as {
      worktreePath: string;
      branch: string;
      headSha: string;
      repoRoot: string;
      createdAt: string;
    };

    const worktree: WorktreeInfo = {
      worktreePath: worktreeRaw.worktreePath,
      branch: worktreeRaw.branch,
      headSha: worktreeRaw.headSha,
      repoRoot: worktreeRaw.repoRoot,
      createdAt: new Date(worktreeRaw.createdAt),
    };

    const session: Session = {
      id: row['id'] as string,
      displayId: row['display_id'] as number,
      instanceId: row['instance_id'] as string,
      status: row['status'] as SessionStatus,
      config: decryptJson<SessionConfig>(row['config_json'] as string),
      worktree,
      createdAt: new Date(row['created_at'] as string),
      updatedAt: new Date(row['updated_at'] as string),
    };

    if (startedAt !== null) {
      session.startedAt = new Date(startedAt);
    }
    if (completedAt !== null) {
      session.completedAt = new Date(completedAt);
    }
    if (exitCode !== null) {
      session.exitCode = exitCode;
    }
    if (errorMessage !== null) {
      session.errorMessage = errorMessage;
    }

    const historyCapturedAt = row['history_captured_at'] as string | null;
    const historySizeBytes = row['history_size_bytes'] as number | null;
    const historyMessageCount = row['history_message_count'] as number | null;
    if (historyCapturedAt !== null) {
      session.historyCapturedAt = new Date(historyCapturedAt);
    }
    if (historySizeBytes !== null) {
      session.historySizeBytes = historySizeBytes;
    }
    if (historyMessageCount !== null) {
      session.historyMessageCount = historyMessageCount;
    }

    return session;
  }

  createSession(config: SessionConfig, worktree: WorktreeInfo, id?: string): Session {
    const worktreeJson = JSON.stringify({
      worktreePath: worktree.worktreePath,
      branch: worktree.branch,
      headSha: worktree.headSha,
      repoRoot: worktree.repoRoot,
      createdAt: worktree.createdAt.toISOString(),
    });

    const sessionId = id ?? crypto.randomUUID();

    this.#db.transaction(() => {
      const nextRow = this.#db
        .prepare('SELECT COALESCE(MAX(display_id), 0) + 1 AS next FROM sessions')
        .get() as { next: number };
      const displayId = nextRow.next;

      const now = new Date().toISOString();

      this.#db
        .prepare(
          `INSERT INTO sessions
            (id, display_id, instance_id, status, config_json, worktree_json, repo_root, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
        )
        .run(sessionId, displayId, config.instanceId, encryptJson(config), worktreeJson, config.repoRoot, now, now);
    })();

    return this.getSession(sessionId)!;
  }

  getSession(id: string): Session | undefined {
    const row = this.#db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return undefined;
    return this.#rowToSession(row);
  }

  getSessionByDisplayId(displayId: number): Session | undefined {
    const row = this.#db.prepare('SELECT * FROM sessions WHERE display_id = ?').get(displayId) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return undefined;
    return this.#rowToSession(row);
  }

  listSessions(instanceId?: string): Session[] {
    let rows: Record<string, unknown>[];
    if (instanceId !== undefined) {
      rows = this.#db
        .prepare('SELECT * FROM sessions WHERE instance_id = ? ORDER BY display_id ASC')
        .all(instanceId) as Record<string, unknown>[];
    } else {
      rows = this.#db.prepare('SELECT * FROM sessions ORDER BY display_id ASC').all() as Record<
        string,
        unknown
      >[];
    }
    return rows.map((row) => this.#rowToSession(row));
  }

  updateStatus(id: string, to: SessionStatus, note?: string): Session {
    this.#db.transaction(() => {
      const session = this.getSession(id);
      if (session === undefined) {
        throw new TypeError(`Session not found: ${id}`);
      }

      const from = session.status;
      assertValidTransition(from, to);

      const now = new Date().toISOString();
      const isTerminal = to === 'completed' || to === 'failed' || to === 'cancelled';

      let sql: string;
      let params: (string | null)[];

      if (to === 'running') {
        sql = 'UPDATE sessions SET status = ?, updated_at = ?, started_at = ? WHERE id = ?';
        params = [to, now, now, id];
      } else if (isTerminal) {
        sql = 'UPDATE sessions SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?';
        params = [to, now, now, id];
      } else {
        sql = 'UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?';
        params = [to, now, id];
      }

      this.#db.prepare(sql).run(...params);

      this.#db
        .prepare(
          'INSERT INTO status_events (session_id, from_status, to_status, occurred_at, note) VALUES (?, ?, ?, ?, ?)',
        )
        .run(id, from, to, now, note ?? null);
    })();

    return this.getSession(id)!;
  }

  updateSession(id: string, patch: { errorMessage?: string; exitCode?: number }): Session {
    this.#db.transaction(() => {
      const session = this.getSession(id);
      if (session === undefined) {
        throw new TypeError(`Session not found: ${id}`);
      }

      const now = new Date().toISOString();
      this.#db
        .prepare(
          'UPDATE sessions SET error_message = ?, exit_code = ?, updated_at = ? WHERE id = ?',
        )
        .run(patch.errorMessage ?? null, patch.exitCode ?? null, now, id);
    })();

    return this.getSession(id)!;
  }

  /**
   * Mark all sessions stuck in 'running' or 'starting' as 'failed'.
   * Called at startup — any session that was active before a server restart
   * has lost its PTY process and can't recover.
   */
  reconcileOrphanedSessions(): number {
    const rows = this.#db
      .prepare("SELECT id FROM sessions WHERE status IN ('running', 'starting')")
      .all() as { id: string }[];

    for (const row of rows) {
      try {
        this.updateStatus(row.id, 'failed', 'Server restarted while session was active');
      } catch {
        // Best-effort: skip if transition fails
      }
    }

    if (rows.length > 0) {
      console.log(`[session-store] reconciled ${rows.length} orphaned session(s) → failed`);
    }

    return rows.length;
  }

  /**
   * Clear stale exit data so a reopened session looks fresh.
   * Resets exit_code, error_message, completed_at and bumps updated_at.
   */
  resetForReopen(id: string): Session {
    const session = this.getSession(id);
    if (session === undefined) {
      throw new TypeError(`Session not found: ${id}`);
    }

    const now = new Date().toISOString();
    this.#db
      .prepare(
        'UPDATE sessions SET exit_code = NULL, error_message = NULL, completed_at = NULL, updated_at = ? WHERE id = ?',
      )
      .run(now, id);

    return this.getSession(id)!;
  }

  /**
   * Updates the worktree path in worktree_json, preserving all other fields.
   * Used when a worktree is restored to a different location (e.g. migration
   * from /data/worktrees to /tmp/orcha-worktrees after container restart).
   */
  updateWorktreePath(id: string, newWorktreePath: string): Session {
    const session = this.getSession(id);
    if (session === undefined) {
      throw new TypeError(`Session not found: ${id}`);
    }

    const worktreeJson = JSON.stringify({
      worktreePath: newWorktreePath,
      branch: session.worktree.branch,
      headSha: session.worktree.headSha,
      repoRoot: session.worktree.repoRoot,
      createdAt: session.worktree.createdAt.toISOString(),
    });

    const now = new Date().toISOString();
    this.#db
      .prepare('UPDATE sessions SET worktree_json = ?, updated_at = ? WHERE id = ?')
      .run(worktreeJson, now, id);

    return this.getSession(id)!;
  }

  updateHistory(id: string, patch: { capturedAt: string; sizeBytes: number; messageCount: number }): Session {
    const session = this.getSession(id);
    if (session === undefined) {
      throw new TypeError(`Session not found: ${id}`);
    }

    const now = new Date().toISOString();
    this.#db
      .prepare(
        'UPDATE sessions SET history_captured_at = ?, history_size_bytes = ?, history_message_count = ?, updated_at = ? WHERE id = ?',
      )
      .run(patch.capturedAt, patch.sizeBytes, patch.messageCount, now, id);

    return this.getSession(id)!;
  }

  findByBranchAndRepo(branch: string, repoRoot: string): Session | undefined {
    const row = this.#db
      .prepare(
        `SELECT * FROM sessions
         WHERE json_extract(worktree_json, '$.branch') = ?
           AND repo_root = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(branch, repoRoot) as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    return this.#rowToSession(row);
  }

  deleteSession(id: string): void {
    const session = this.getSession(id);
    if (session === undefined) {
      throw new TypeError(`Session not found: ${id}`);
    }

    this.#db.transaction(() => {
      // Clear FK reference from tasks before deleting the session
      this.#db.prepare('UPDATE tasks SET session_id = NULL WHERE session_id = ?').run(id);
      this.#db.prepare('DELETE FROM session_credentials WHERE session_id = ?').run(id);
      this.#db.prepare('DELETE FROM status_events WHERE session_id = ?').run(id);
      this.#db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    })();
  }
}
