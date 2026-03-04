export interface StoragePaths {
  dataDir: string;
  dbPath: string;
  bareRepoDir: string;
  worktreeBaseDir: string;
  logsDir: string;
  caddyDataDir: string;
}

let _cached: StoragePaths | undefined;

export function getStoragePaths(): StoragePaths {
  if (_cached !== undefined) {
    return _cached;
  }

  const dataDir = process.env['ORCHA_DATA_DIR'] ?? '/data';
  const dbDir = process.env['ORCHA_DB_DIR'] ?? dataDir;
  const worktreeDir = process.env['ORCHA_WORKTREE_DIR'] ?? '/tmp/orcha-worktrees';

  _cached = {
    dataDir,
    dbPath: `${dbDir}/orcha.db`,
    bareRepoDir: `${dataDir}/bare-repos`,
    worktreeBaseDir: worktreeDir,
    logsDir: `${dataDir}/logs`,
    caddyDataDir: `${dataDir}/caddy`,
  };

  return _cached;
}
