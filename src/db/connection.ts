import Database from 'better-sqlite3';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { getStoragePaths } from '../storage/paths.js';

export function openDatabase(dataPath: string): Database.Database {
  const filename = dataPath === ':memory:' ? ':memory:' : path.join(dataPath, 'orcha.db');
  if (filename !== ':memory:') {
    mkdirSync(path.dirname(filename), { recursive: true });
  }
  // busy_timeout: 60s — on ACA rolling updates the old revision holds an
  // exclusive lock briefly while the new replica starts up. 60s is enough
  // for the old revision to drain and release the lock.
  const db = new Database(filename, { timeout: 60000 });
  // Azure File Share (SMB) does not support POSIX advisory locking required
  // for WAL mode. Use DELETE journal mode on network-mounted volumes.
  db.pragma('journal_mode = DELETE');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('locking_mode = EXCLUSIVE');
  return db;
}

let _db: Database.Database | undefined;

export function getDb(): Database.Database {
  if (_db === undefined) {
    const { dbPath } = getStoragePaths();
    _db = openDatabase(path.dirname(dbPath));
  }
  return _db;
}
