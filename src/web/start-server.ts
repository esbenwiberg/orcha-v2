import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, SessionStore, InstanceRegistry } from '@orcha/db';
import { CredentialStore } from '../db/credential-store.js';
import { ModelConfigStore } from '../db/model-config-store.js';
import { WorktreeManager } from '../terminal/worktree-manager.js';
import { PtyManager } from '../terminal/pty-manager.js';
import { SessionManager } from '../terminal/session-manager.js';
import { AuthTerminalManager } from '../terminal/auth-terminal-manager.js';
import { startServer } from './server.js';
import type { AppDeps } from './app.js';
import { loadAuthConfig } from './auth/index.js';
import { ValidationManager } from '../validation/validation-manager.js';
import { emitStartupDiagnostics } from '../diagnostics/startup.js';
import { getStoragePaths } from '../storage/paths.js';
import { GlobalSettingsStore } from '../db/global-settings-store.js';
import { installEnabledSdks } from '../sdk-installer.js';
import { TaskProcessor } from '../tasks/task-processor.js';

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

// Ensure shared ~/.claude/settings.json has theme=dark so claude doesn't show
// the first-run theme picker in any session (auth or regular).
try {
  const claudeDir = path.join(homedir(), '.claude');
  mkdirSync(claudeDir, { recursive: true });
  const settingsPath = path.join(claudeDir, 'settings.json');
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>; } catch { /* ignore */ }
  }
  if (!('theme' in settings)) {
    settings['theme'] = 'dark';
    writeFileSync(settingsPath, JSON.stringify(settings), 'utf8');
  }
} catch { /* best-effort */ }

const db = openDatabase(path.dirname(dbPath));
runMigrations(db, migrationsDir);

// One-time seed: import existing .claude/settings.json into DB if not already there.
// This covers the first deploy after switching from file-based to DB-backed settings.
try {
  const globalSettings = new GlobalSettingsStore(db);
  if (!globalSettings.has('claude_settings')) {
    const settingsFile = path.join(homedir(), '.claude', 'settings.json');
    if (existsSync(settingsFile)) {
      const raw = readFileSync(settingsFile, 'utf8');
      // Validate it's parseable JSON before storing
      JSON.parse(raw);
      globalSettings.set('claude_settings', raw);
      console.log('[settings] seeded claude_settings into DB from .claude/settings.json');
    }
  }
} catch (e) {
  console.warn('[settings] failed to seed claude_settings from file:', e);
}

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
sessionStore.reconcileOrphanedSessions();
const credentialStore = new CredentialStore(db);
const worktreeManager = new WorktreeManager({ repoRoot });
const ptyManager = new PtyManager();

// Register this Orcha instance so sessions can satisfy the FK constraint.
// upsertInstance handles both first-run and restarts gracefully.
const instanceRegistry = new InstanceRegistry(db);
const instanceId = 'local';
const now = new Date();
instanceRegistry.upsertInstance({ id: instanceId, repoRoot, registeredAt: now, lastSeenAt: now });

const modelConfigStore = new ModelConfigStore(db);
const sessionEngine = new SessionManager(worktreeManager, ptyManager, sessionStore, credentialStore, instanceId, modelConfigStore);

const validationManager = new ValidationManager();
sessionEngine.setValidationManager(validationManager);

const authConfig = loadAuthConfig();
const authTerminalManager = new AuthTerminalManager();

const deps: AppDeps = { sessionEngine, worktreeManager, db, authConfig, authTerminalManager, validationManager };

// Start the task pipeline processor (background loop)
const taskProcessor = new TaskProcessor({ db, sessionManager: sessionEngine });
taskProcessor.start(10_000);

process.on('SIGTERM', () => {
  taskProcessor.stop();
});

startServer(deps, port)
  .then(() => {
    process.stdout.write(`Orcha listening on http://127.0.0.1:${port}\n`);
    // Install SDKs in the background after the server is listening,
    // so health probes pass while large SDKs (dotnet ~240 MB) download.
    installEnabledSdks(db).catch((err: unknown) => {
      console.error('[sdks] background install failed:', err);
    });
  })
  .catch((err: unknown) => {
    process.stderr.write(`Failed to start server: ${String(err)}\n`);
    process.exit(1);
  });
