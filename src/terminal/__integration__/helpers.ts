import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { openDatabase } from '../../db/connection.js';
import { runMigrations } from '../../db/migrate.js';
import { SessionStore } from '../../db/session-store.js';

const execFileP = promisify(execFile);

export async function makeTestRepo(): Promise<{
  repoRoot: string;
  worktreesDir: string;
  cleanup: () => Promise<void>;
}> {
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'orcha-test-'));
  const repoRoot = path.join(tmpBase, 'repo');
  const worktreesDir = path.join(tmpBase, 'worktrees');

  await fs.mkdir(repoRoot, { recursive: true });
  await fs.mkdir(worktreesDir, { recursive: true });

  await execFileP('git', ['init'], { cwd: repoRoot });
  await execFileP('git', ['config', 'user.email', 'test@test.com'], { cwd: repoRoot });
  await execFileP('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
  await fs.writeFile(path.join(repoRoot, 'README.md'), '# test');
  await execFileP('git', ['add', '.'], { cwd: repoRoot });
  await execFileP('git', ['commit', '-m', 'init'], { cwd: repoRoot });

  return {
    repoRoot,
    worktreesDir,
    cleanup: async () => {
      await fs.rm(tmpBase, { recursive: true, force: true });
    },
  };
}

export const MIGRATIONS_DIR = new URL('../../db/migrations', import.meta.url).pathname;

export async function makeSqliteStore(dbPath: string): Promise<SessionStore> {
  const db = openDatabase(dbPath);
  runMigrations(db, MIGRATIONS_DIR);
  return new SessionStore(db);
}
