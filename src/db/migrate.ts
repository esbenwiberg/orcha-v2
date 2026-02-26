import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export function runMigrations(db: Database.Database, migrationsDir: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const match = /^(\d+)/.exec(file);
    if (match === null || match[1] === undefined) continue;
    const version = parseInt(match[1], 10);

    const existing = db
      .prepare('SELECT version FROM schema_migrations WHERE version = ?')
      .get(version);

    if (existing !== undefined) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

    db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        version,
        new Date().toISOString(),
      );
    })();
  }
}
