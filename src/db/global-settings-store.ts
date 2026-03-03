import Database from 'better-sqlite3';
import { encrypt, decrypt } from '../credentials/crypto.js';

export class GlobalSettingsStore {
  #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  get(key: string): string | undefined {
    const row = this.#db
      .prepare('SELECT value FROM global_settings WHERE key = ?')
      .get(key) as { value: string } | undefined;
    if (!row) return undefined;
    return decrypt(row.value);
  }

  set(key: string, plaintext: string): void {
    const encrypted = encrypt(plaintext);
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO global_settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, encrypted, now);
  }

  delete(key: string): void {
    this.#db.prepare('DELETE FROM global_settings WHERE key = ?').run(key);
  }

  has(key: string): boolean {
    const row = this.#db
      .prepare('SELECT 1 FROM global_settings WHERE key = ?')
      .get(key);
    return row !== undefined;
  }
}
