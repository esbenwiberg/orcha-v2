import Database from 'better-sqlite3';
import type { InstanceInfo } from '@orcha/domain';

interface InstanceRow {
  id: string;
  repo_root: string;
  registered_at: string;
  last_seen_at: string;
  active_sessions: number;
}

export class InstanceRegistry {
  #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  #rowToInstanceInfo(row: Record<string, unknown>): InstanceInfo {
    return {
      id: row['id'] as string,
      repoRoot: row['repo_root'] as string,
      registeredAt: new Date(row['registered_at'] as string),
      lastSeenAt: new Date(row['last_seen_at'] as string),
      activeSessions: row['active_sessions'] as number,
    };
  }

  listInstances(): InstanceInfo[] {
    const rows = this.#db
      .prepare('SELECT * FROM instances ORDER BY registered_at ASC')
      .all() as InstanceRow[];
    return rows.map((row) => this.#rowToInstanceInfo(row as unknown as Record<string, unknown>));
  }

  getInstance(id: string): InstanceInfo | undefined {
    const row = this.#db.prepare('SELECT * FROM instances WHERE id = ?').get(id) as
      | InstanceRow
      | undefined;
    if (row === undefined) return undefined;
    return this.#rowToInstanceInfo(row as unknown as Record<string, unknown>);
  }

  registerInstance(info: Omit<InstanceInfo, 'activeSessions'>): InstanceInfo {
    const existing = this.getInstance(info.id);
    if (existing !== undefined) {
      throw new TypeError(`Instance already registered: ${info.id}`);
    }
    this.#db
      .prepare(
        'INSERT INTO instances (id, repo_root, registered_at, last_seen_at) VALUES (?, ?, ?, ?)',
      )
      .run(info.id, info.repoRoot, info.registeredAt.toISOString(), info.lastSeenAt.toISOString());
    const inserted = this.getInstance(info.id);
    if (inserted === undefined) {
      throw new Error(`Failed to retrieve instance after insert: ${info.id}`);
    }
    return inserted;
  }

  unregisterInstance(id: string): void {
    const existing = this.getInstance(id);
    if (existing === undefined) {
      throw new TypeError(`Instance not found: ${id}`);
    }
    this.#db.prepare('DELETE FROM instances WHERE id = ?').run(id);
  }

  updateLastSeen(id: string): void {
    this.#db
      .prepare('UPDATE instances SET last_seen_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
  }
}
