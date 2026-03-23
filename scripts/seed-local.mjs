#!/usr/bin/env node
/**
 * Seed a local Orcha DB from a mounted ACA file share.
 *
 * Copies the ACA's orcha.db, strips runtime data (sessions, tasks, messages),
 * and resets all repos to 'pending' so they get re-cloned locally.
 *
 * Environment:
 *   ACA_MOUNT   — path to mounted ACA file share (default: /mnt/aca)
 *   LOCAL_DATA  — local data directory (default: /data)
 *   SEED_FORCE  — set to "1" to re-seed even if local DB exists
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const acaMount = process.env['ACA_MOUNT'] ?? '/mnt/aca';
const localData = process.env['LOCAL_DATA'] ?? process.env['ORCHA_DATA_DIR'] ?? '/data';
const force = process.env['SEED_FORCE'] === '1';

const acaDb = join(acaMount, 'orcha.db');
const localDb = join(localData, 'orcha.db');

// Guard: already seeded?
if (existsSync(localDb) && !force) {
  console.log('[seed] local DB already exists at %s — skipping (set SEED_FORCE=1 to overwrite)', localDb);
  process.exit(0);
}

// Guard: ACA DB available?
if (!existsSync(acaDb)) {
  console.log('[seed] no ACA DB found at %s — starting fresh (nothing to seed)', acaDb);
  process.exit(0);
}

// Copy the full DB
mkdirSync(localData, { recursive: true });
copyFileSync(acaDb, localDb);
console.log('[seed] copied ACA DB → %s', localDb);

// Open and scrub runtime tables
const db = new Database(localDb);
db.pragma('journal_mode = WAL');

// Tables ordered to respect FK constraints (children first)
const runtimeTables = [
  'session_messages',
  'channel_members',
  'message_channels',
  'task_transcript',
  'task_events',
  'tasks',
  'session_credentials',
  'status_events',
  'sessions',
  'web_sessions',
  'instances',
];

const scrub = db.transaction(() => {
  for (const table of runtimeTables) {
    try {
      const info = db.prepare(`DELETE FROM "${table}"`).run();
      if (info.changes > 0) {
        console.log('[seed]   cleared %s (%d rows)', table, info.changes);
      }
    } catch (err) {
      // Table might not exist in older DB versions — skip gracefully
      console.warn('[seed]   skipped %s: %s', table, err.message);
    }
  }

  // Reset all repos to pending — triggers re-clone on first use
  const repoInfo = db.prepare("UPDATE repos SET status = 'pending', bare_path = NULL").run();
  console.log('[seed]   reset %d repos to pending (will re-clone)', repoInfo.changes);
});

scrub();
db.close();

console.log('[seed] done — config (repos, presets, models, credentials, settings) ready');
console.log('[seed] repos will re-clone when you hit "clone" in the UI');
