import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from './connection.js';
import { runMigrations } from './migrate.js';

const MIGRATIONS_DIR = 'src/db/migrations';

describe('runMigrations', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  it('(a) does not throw on first run', () => {
    expect(() => runMigrations(db, MIGRATIONS_DIR)).not.toThrow();
  });

  it('(b) is idempotent when called a second time', () => {
    runMigrations(db, MIGRATIONS_DIR);
    expect(() => runMigrations(db, MIGRATIONS_DIR)).not.toThrow();
  });

  it('(c) creates instances, sessions, and status_events tables', () => {
    runMigrations(db, MIGRATIONS_DIR);

    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('instances', 'sessions', 'status_events')`,
      )
      .all() as Array<{ name: string }>;

    const names = tables.map((t) => t.name).sort();
    expect(names).toEqual(['instances', 'sessions', 'status_events']);
  });

  it('(d) schema_migrations has rows for all applied migrations', () => {
    runMigrations(db, MIGRATIONS_DIR);

    const rows = db
      .prepare('SELECT version FROM schema_migrations ORDER BY version ASC')
      .all() as Array<{
      version: number;
    }>;
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows[0]?.version).toBe(1);
    expect(rows[1]?.version).toBe(2);
  });
});
