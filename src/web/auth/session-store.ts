import session from 'express-session';
import type Database from 'better-sqlite3';

/**
 * SQLite-backed session store for express-session using better-sqlite3.
 *
 * Replaces the default MemoryStore so sessions survive container restarts
 * and work when the app scales to multiple instances sharing the same DB.
 */
export class SqliteSessionStore extends session.Store {
  private getStmt: Database.Statement;
  private setStmt: Database.Statement;
  private destroyStmt: Database.Statement;
  private touchStmt: Database.Statement;

  constructor(db: Database.Database) {
    super();

    this.getStmt = db.prepare(
      'SELECT data FROM web_sessions WHERE sid = ? AND expires > ?',
    );
    this.setStmt = db.prepare(
      'INSERT OR REPLACE INTO web_sessions (sid, data, expires) VALUES (?, ?, ?)',
    );
    this.destroyStmt = db.prepare('DELETE FROM web_sessions WHERE sid = ?');
    this.touchStmt = db.prepare('UPDATE web_sessions SET expires = ? WHERE sid = ?');

    // Purge expired sessions on startup
    db.prepare('DELETE FROM web_sessions WHERE expires <= ?').run(Date.now());
  }

  get(
    sid: string,
    callback: (err?: unknown, session?: session.SessionData | null) => void,
  ): void {
    try {
      const row = this.getStmt.get(sid, Date.now()) as { data: string } | undefined;
      callback(null, row !== undefined ? (JSON.parse(row.data) as session.SessionData) : null);
    } catch (err) {
      callback(err);
    }
  }

  set(sid: string, sessionData: session.SessionData, callback?: (err?: unknown) => void): void {
    try {
      const maxAge = sessionData.cookie?.maxAge ?? 86_400_000; // 24 h default
      const expires = Date.now() + maxAge;
      this.setStmt.run(sid, JSON.stringify(sessionData), expires);
      callback?.();
    } catch (err) {
      callback?.(err);
    }
  }

  destroy(sid: string, callback?: (err?: unknown) => void): void {
    try {
      this.destroyStmt.run(sid);
      callback?.();
    } catch (err) {
      callback?.(err);
    }
  }

  touch(sid: string, sessionData: session.SessionData, callback?: () => void): void {
    try {
      const maxAge = sessionData.cookie?.maxAge ?? 86_400_000;
      const expires = Date.now() + maxAge;
      this.touchStmt.run(expires, sid);
    } catch {
      // touch errors are non-critical — don't propagate
    }
    callback?.();
  }
}
