import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDatabase, runMigrations, SessionStore, InstanceRegistry, RepoStore } from '@orcha/db';
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
import { registerSyncFn } from '../db/db-sync.js';
import { installEnabledSdks } from '../sdk-installer.js';
import { TaskProcessor } from '../tasks/task-processor.js';
import { CleanupService } from '../terminal/cleanup-service.js';
import { StatusMonitor } from '../terminal/status-monitor.js';
import { eventBus } from './services/event-bus.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// --- Global crash safety net ---
// Without these handlers, any uncaught error (e.g. native node-pty EBADF)
// crashes the process silently. Log the error so we have visibility, then
// let the container restart cleanly.
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException — process will exit:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection — process will exit:', reason);
  process.exit(1);
});

await emitStartupDiagnostics();

const port = parseInt(process.env['PORT'] ?? '3000', 10);
const repoRoot = process.env['REPO_ROOT'] ?? process.cwd();
const migrationsDir = path.resolve(__dirname, '../db/migrations');

// --- DB persistence bridge ---
// SQLite can't run reliably on Azure File Share (SMB has no chmod/flock
// support). Live DB stays in /tmp (local SSD, full POSIX support).
// On startup we restore from /data if a backup exists.
// Every 30s + on SIGTERM we serialize the DB and write it back to /data.
// Backup rotation keeps the last N copies so OOM-kill can't lose everything.
const { dataDir, dbPath } = getStoragePaths();
// dbPath            = /tmp/orcha-db/orcha.db  (ORCHA_DB_DIR=/tmp/orcha-db)
// persistentDbPath  = /data/orcha.db          (ORCHA_DATA_DIR=/data)
const persistentDbPath = path.join(dataDir, 'orcha.db');
const backupDir = path.join(dataDir, 'db-backups');

mkdirSync(path.dirname(dbPath), { recursive: true });
mkdirSync(backupDir, { recursive: true });

// Restore: prefer the primary file, fall back to the newest backup
if (!existsSync(dbPath)) {
  let restored = false;
  if (existsSync(persistentDbPath)) {
    try {
      const data = readFileSync(persistentDbPath);
      // Sanity check: SQLite files start with "SQLite format 3\0"
      if (data.length > 100 && data.toString('utf8', 0, 15) === 'SQLite format 3') {
        writeFileSync(dbPath, data);
        console.log('[db] restored from persistent primary (%d bytes)', data.length);
        restored = true;
      } else {
        console.warn('[db] persistent primary is corrupted (%d bytes) — trying backups', data.length);
      }
    } catch (e) {
      console.error('[db] restore from primary failed:', e);
    }
  }
  if (!restored) {
    // Try backups newest-first
    try {
      const backups = readdirSync(backupDir)
        .filter((f) => f.startsWith('orcha-') && f.endsWith('.db'))
        .sort()
        .reverse();
      for (const backup of backups) {
        try {
          const data = readFileSync(path.join(backupDir, backup));
          if (data.length > 100 && data.toString('utf8', 0, 15) === 'SQLite format 3') {
            writeFileSync(dbPath, data);
            console.log('[db] restored from backup %s (%d bytes)', backup, data.length);
            restored = true;
            break;
          }
        } catch { /* try next */ }
      }
      if (!restored && backups.length > 0) {
        console.error('[db] all %d backups are corrupted — starting fresh', backups.length);
      }
    } catch { /* no backups dir */ }
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
const MAX_BACKUPS = 10;
let _backupRotationCounter = 0;

/** Write DB to persistent storage. Every 5th call also rotates a timestamped backup. */
const syncDbToPersistent = () => {
  try {
    const data = db.serialize();
    // Write to temp file first, then rename — avoids half-written files on crash.
    // Azure Files SMB doesn't support atomic rename, but a write+unlink+write is
    // still safer than overwriting in-place (partial write = corruption).
    const tmpPath = persistentDbPath + '.tmp';
    writeFileSync(tmpPath, data);
    // Swap: remove old, rename new. If we crash between these two calls,
    // the restore logic will fall back to the backup dir.
    try { unlinkSync(persistentDbPath); } catch { /* may not exist */ }
    // renameSync doesn't work on Azure Files cross-device; use copy+delete
    writeFileSync(persistentDbPath, readFileSync(tmpPath));
    try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }

    // Rotate a backup every 5th sync (~2.5 min with 30s interval)
    _backupRotationCounter++;
    if (_backupRotationCounter >= 5) {
      _backupRotationCounter = 0;
      try {
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        writeFileSync(path.join(backupDir, `orcha-${ts}.db`), data);

        // Prune old backups beyond MAX_BACKUPS
        const files = readdirSync(backupDir)
          .filter((f) => f.startsWith('orcha-') && f.endsWith('.db'))
          .sort();
        while (files.length > MAX_BACKUPS) {
          const oldest = files.shift()!;
          try { unlinkSync(path.join(backupDir, oldest)); } catch { /* ignore */ }
        }
      } catch (e) {
        console.error('[db] backup rotation failed:', e);
      }
    }
  } catch (e) {
    console.error('[db] sync to persistent storage failed:', e);
  }
};

// Register the sync function so route handlers can trigger immediate syncs
// after critical mutations (task/preset/repo writes).
registerSyncFn(syncDbToPersistent);

setInterval(syncDbToPersistent, 30_000).unref();

process.on('SIGTERM', () => {
  syncDbToPersistent();
  process.exit(0);
});
// --- end DB persistence bridge ---

const sessionStore = new SessionStore(db);
sessionStore.reconcileOrphanedSessions();
const repoStore = new RepoStore(db);
const stalledCount = repoStore.reconcileStalledClones();
if (stalledCount > 0) console.log(`[startup] reset ${stalledCount} stalled repo clone(s) to pending`);
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
const sessionEngine = new SessionManager(worktreeManager, ptyManager, sessionStore, credentialStore, instanceId, modelConfigStore, dataDir);

const validationManager = new ValidationManager();
sessionEngine.setValidationManager(validationManager);

// Wire terminal status monitor → SSE badge updates
const statusMonitor = new StatusMonitor();
sessionEngine.setStatusMonitor(statusMonitor);
statusMonitor.on('status-change', (e) => {
  // When the monitor detects the agent needs human input, push a badge update.
  // When activity resumes, push the badge back to "running".
  if (e.status === 'needs-input' || e.status === 'idle') {
    eventBus.publish({ type: 'status', sessionId: e.sessionId, status: 'needs-input' });
  } else if (e.prevStatus === 'needs-input' || e.prevStatus === 'idle') {
    eventBus.publish({ type: 'status', sessionId: e.sessionId, status: 'running' });
  }
});

const authConfig = loadAuthConfig();
const authTerminalManager = new AuthTerminalManager();

const deps: AppDeps = { sessionEngine, worktreeManager, db, authConfig, authTerminalManager, validationManager };

// Start background cleanup service (stale sessions, orphaned worktrees, expired creds)
const cleanupService = new CleanupService(sessionEngine, worktreeManager, sessionStore, 60_000, credentialStore);
cleanupService.setValidationManager(validationManager);
cleanupService.start();

cleanupService.on('cleanup-error', (err) => {
  console.error('[cleanup] background sweep failed:', err);
});

// Start the task pipeline processor (background loop)
const taskProcessor = new TaskProcessor({ db, sessionManager: sessionEngine, worktreeManager });
taskProcessor.start(10_000);

process.on('SIGTERM', () => {
  // Capture refreshed OAuth credentials from all active sessions before shutdown.
  // During deploys/restarts, sessions may have rotated refresh tokens that haven't
  // been persisted yet (the exit handler in session-manager runs async and may not
  // complete before the process is killed).
  try {
    const activeSessions = sessionEngine.listSessions();
    for (const session of activeSessions) {
      if (session.homeDir && session.modelConfigId) {
        try {
          const credsPath = path.join(session.homeDir, '.claude', '.credentials.json');
          if (existsSync(credsPath)) {
            const credsJson = readFileSync(credsPath, 'utf8');
            const current = modelConfigStore.getConfig(session.modelConfigId);
            if (current?.credentialsJson !== credsJson) {
              modelConfigStore.updateConfig(session.modelConfigId, { credentialsJson: credsJson });
              console.log('[shutdown] captured credentials sessionId=%s modelConfigId=%s', session.sessionId, session.modelConfigId);
            }
          }
        } catch (err) {
          console.warn('[shutdown] credential capture failed for session %s:', session.sessionId, err);
        }
      }
    }
  } catch (err) {
    console.warn('[shutdown] credential sweep failed:', err);
  }

  cleanupService.stop();
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
