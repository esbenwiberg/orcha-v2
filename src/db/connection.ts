import Database from 'better-sqlite3';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { getStoragePaths } from '../storage/paths.js';

export function openDatabase(dataPath: string): Database.Database {
  const filename = dataPath === ':memory:' ? ':memory:' : path.join(dataPath, 'orcha.db');
  if (filename !== ':memory:') {
    mkdirSync(path.dirname(filename), { recursive: true });
  }
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  return db;
}

let _db: Database.Database | undefined;

export function getDb(): Database.Database {
  if (_db === undefined) {
    const { dataDir } = getStoragePaths();
    _db = openDatabase(dataDir);
  }
  return _db;
}
