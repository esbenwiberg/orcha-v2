import path from 'node:path';
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

const { dataDir, dbPath } = getStoragePaths();
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
