import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getStoragePaths } from '../storage/paths.js';
import { checkVolumeMount } from '../storage/volume-check.js';
import { loadSandboxConfig } from '../sandbox/sandbox-config.js';

function getGitVersion(): string {
  try {
    return execSync('git --version', { encoding: 'utf8' }).trim();
  } catch {
    return 'git not found';
  }
}

function isSandboxAvailable(mode: string): boolean {
  try {
    if (mode === 'landlock') {
      execSync('landlock-exec /tmp /tmp -- /bin/true', {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      });
    } else {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function getNodePtyVersion(): string {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const pkgPath = path.resolve(path.dirname(thisFile), '../../node_modules/node-pty/package.json');
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export async function emitStartupDiagnostics(): Promise<void> {
  const paths = getStoragePaths();
  const { persistent: data_persistent, warning: data_warning } = await checkVolumeMount(
    paths.dataDir,
  );

  const sandboxConfig = loadSandboxConfig();
  const diagnostics = {
    event: 'startup_diagnostics',
    auth_mode: process.env['AUTH_MODE'] ?? 'none',
    db_path: paths.dbPath,
    worktree_base: paths.worktreeBaseDir,
    bare_repo_dir: paths.bareRepoDir,
    node_version: process.version,
    git_version: getGitVersion(),
    node_pty_version: getNodePtyVersion(),
    sandbox_mode: sandboxConfig.mode,
    sandbox_available: isSandboxAvailable(sandboxConfig.mode),
    data_persistent,
    data_warning,
  };

  console.log(JSON.stringify(diagnostics));

  if (data_warning !== null) {
    console.warn(data_warning);
  }
}
