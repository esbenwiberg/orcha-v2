import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, SessionStore, InstanceRegistry } from '@orcha/db';
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
// support). Live DB stays in /tmp (local SSD, full POSIX support).
// On startup we restore from /data if a backup exists.
// Every 30s + on SIGTERM we serialize the DB and write it back to /data.
const { dataDir, dbPath } = getStoragePaths();
// dbPath            = /tmp/orcha-db/orcha.db  (ORCHA_DB_DIR=/tmp/orcha-db)
// persistentDbPath  = /data/orcha.db          (ORCHA_DATA_DIR=/data)
const persistentDbPath = path.join(dataDir, 'orcha.db');

mkdirSync(path.dirname(dbPath), { recursive: true });

if (!existsSync(dbPath) && existsSync(persistentDbPath)) {
  try {
    // readFileSync + writeFileSync uses plain read/write syscalls that
    // work on both local SSD and Azure File Share.
    writeFileSync(dbPath, readFileSync(persistentDbPath));
    console.log('[db] restored from persistent backup');
  } catch (e) {
    console.error('[db] restore from backup failed:', e);
  }
}

const db = openDatabase(path.dirname(dbPath));
runMigrations(db, migrationsDir);

// db.serialize() produces a consistent byte-for-byte snapshot without needing
// WAL checkpointing or file copying. writeFileSync works on Azure File Share.
const syncDbToPersistent = () => {
  try {
    mkdirSync(path.dirname(persistentDbPath), { recursive: true });
    writeFileSync(persistentDbPath, db.serialize());
  } catch (e) {
    console.error('[db] sync to persistent storage failed:', e);
  }
};

setInterval(syncDbToPersistent, 30_000).unref();

process.on('SIGTERM', () => {
  syncDbToPersistent();
  process.exit(0);
});
// --- end DB persistence bridge ---

const sessionStore = new SessionStore(db);
const credentialStore = new CredentialStore(db);
const worktreeManager = new WorktreeManager({ repoRoot });
const ptyManager = new PtyManager();

// Register this Orcha instance so sessions can satisfy the FK constraint.
// upsertInstance handles both first-run and restarts gracefully.
const instanceRegistry = new InstanceRegistry(db);
const instanceId = 'local';
const now = new Date();
instanceRegistry.upsertInstance({ id: instanceId, repoRoot, registeredAt: now, lastSeenAt: now });

const sessionEngine = new SessionManager(worktreeManager, ptyManager, sessionStore, credentialStore, instanceId);

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
