import path from 'node:path';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, SessionStore } from '@orcha/db';
import { CredentialStore } from '../db/credential-store.js';
import { WorktreeManager } from '../terminal/worktree-manager.js';
import { PtyManager } from '../terminal/pty-manager.js';
import { SessionManager } from '../terminal/session-manager.js';
import { startServer } from './server.js';
import type { AppDeps } from './app.js';
import { loadAuthConfig } from './auth/index.js';
import { emitStartupDiagnostics } from '../diagnostics/startup.js';
import { getStoragePaths } from '../storage/paths.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

await emitStartupDiagnostics();

const port = parseInt(process.env['PORT'] ?? '3000', 10);
const repoRoot = process.env['REPO_ROOT'] ?? process.cwd();
const migrationsDir = path.resolve(__dirname, '../db/migrations');

// --- DB persistence bridge ---
// SQLite can't run reliably on Azure File Share (SMB has no chmod/flock
// support). We keep the live DB in /tmp (local SSD, full POSIX support) and
// sync it to /data for persistence. On startup we restore from /data if
// a backup exists. Every 30s + on SIGTERM we write back.
const { dataDir, dbPath } = getStoragePaths();
// dbPath = /tmp/orcha-db/orcha.db  (ORCHA_DB_DIR=/tmp/orcha-db)
// persistentDbPath = /data/orcha.db (ORCHA_DATA_DIR=/data)
const persistentDbPath = path.join(dataDir, 'orcha.db');

mkdirSync(path.dirname(dbPath), { recursive: true });

if (!existsSync(dbPath) && existsSync(persistentDbPath)) {
  try {
    copyFileSync(persistentDbPath, dbPath);
    console.log('[db] restored from persistent backup');
  } catch (e) {
    console.error('[db] restore from backup failed:', e);
  }
}

const syncDbToPersistent = () => {
  try {
    mkdirSync(path.dirname(persistentDbPath), { recursive: true });
    copyFileSync(dbPath, persistentDbPath);
  } catch (e) {
    console.error('[db] sync to persistent storage failed:', e);
  }
};

// Sync every 30s in the background
setInterval(syncDbToPersistent, 30_000).unref();

// Final sync on graceful shutdown (ACA sends SIGTERM before SIGKILL)
process.on('SIGTERM', () => {
  syncDbToPersistent();
  process.exit(0);
});
// --- end DB persistence bridge ---

const db = openDatabase(path.dirname(dbPath));
runMigrations(db, migrationsDir);

const sessionStore = new SessionStore(db);
const credentialStore = new CredentialStore(db);
const worktreeManager = new WorktreeManager({ repoRoot });
const ptyManager = new PtyManager();
const sessionEngine = new SessionManager(worktreeManager, ptyManager, sessionStore, credentialStore);

const authConfig = loadAuthConfig();

const deps: AppDeps = { sessionEngine, worktreeManager, db, authConfig };

startServer(deps, port)
  .then(() => {
    process.stdout.write(`Orcha listening on http://127.0.0.1:${port}\n`);
  })
  .catch((err: unknown) => {
    process.stderr.write(`Failed to start server: ${String(err)}\n`);
    process.exit(1);
  });
