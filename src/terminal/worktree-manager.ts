import { execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { getStoragePaths } from '../storage/paths.js';

// Git env applied to all git subprocesses.
// safe.directory=* suppresses the "dubious ownership" check that fires when
// the repo on Azure File Share is presented with a different UID than the
// running process.
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'safe.directory',
  GIT_CONFIG_VALUE_0: '*',
};

/**
 * Recursively copies directory contents using plain read/write (no chmod).
 * Azure File Share (SMB) doesn't support chmod so fs.promises.cp can't be used.
 */
function copyDirContents(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirContents(srcPath, destPath);
    } else {
      fs.writeFileSync(destPath, fs.readFileSync(srcPath));
    }
  }
}

export interface WorktreeInfo {
  id: string;
  path: string;
  branch: string;
  commitSha: string;
  createdAt: Date;
}

export interface WorktreeManagerOptions {
  repoRoot: string;
  worktreesBaseDir?: string;
}

export class WorktreeError extends Error {
  code: 'INVALID_BRANCH' | 'INJECTION_ATTEMPT' | 'GIT_ERROR' | 'NOT_FOUND';
  originalError?: unknown;

  constructor(
    message: string,
    code: 'INVALID_BRANCH' | 'INJECTION_ATTEMPT' | 'GIT_ERROR' | 'NOT_FOUND',
    originalError?: unknown,
  ) {
    super(message);
    this.name = 'WorktreeError';
    this.code = code;
    this.originalError = originalError;
  }
}

export class WorktreeManager {
  private options: Required<WorktreeManagerOptions>;

  constructor(options: WorktreeManagerOptions) {
    this.options = {
      repoRoot: options.repoRoot,
      worktreesBaseDir: options.worktreesBaseDir ?? getStoragePaths().worktreeBaseDir,
    };
  }

  private static sanitiseBranchName(raw: string): string {
    let name = raw.trim();
    name = name.replace(/[^a-zA-Z0-9._/-]/g, '-');
    name = name.replace(/-+/g, '-');
    name = name.replace(/^\.+/, '');
    name = name.slice(0, 100);
    if (name.length === 0) {
      throw new WorktreeError('Branch name is empty after sanitisation', 'INVALID_BRANCH');
    }
    return name;
  }

  private static assertNoInjection(value: string, field: string): void {
    if (/[$`|;&><()\n\r]/.test(value)) {
      throw new WorktreeError(
        `Injection attempt detected in field '${field}': ${value}`,
        'INJECTION_ATTEMPT',
      );
    }
  }

  private async execGit(args: string[], cwdOverride?: string): Promise<string> {
    const cwd = cwdOverride ?? this.options.repoRoot;
    return new Promise<string>((resolve, reject) => {
      execFile('git', args, { cwd, env: GIT_ENV }, (err, stdout, stderr) => {
        if (err !== null) {
          reject(new WorktreeError(`git ${args[0]} failed: ${stderr}`, 'GIT_ERROR', err));
        } else {
          resolve(stdout);
        }
      });
    });
  }

  async addWorktree(sessionId: string, branch: string, repoRootOverride?: string, startPoint?: string): Promise<WorktreeInfo> {
    WorktreeManager.assertNoInjection(sessionId, 'sessionId');
    const safeBranch = WorktreeManager.sanitiseBranchName(branch);
    const worktreePath = path.join(this.options.worktreesBaseDir, sessionId);
    const cwd = repoRootOverride ?? undefined;
    const args = ['worktree', 'add', '-b', safeBranch, worktreePath];
    if (startPoint !== undefined) {
      WorktreeManager.assertNoInjection(startPoint, 'startPoint');
      args.push(startPoint);
    }
    await this.execGit(args, cwd);
    const commitShaRaw = await this.execGit(['rev-parse', 'HEAD'], worktreePath);
    const commitSha = commitShaRaw.trim();
    return {
      id: sessionId,
      path: worktreePath,
      branch: safeBranch,
      commitSha,
      createdAt: new Date(),
    };
  }

  async deleteBranch(branch: string, repoRootOverride?: string): Promise<void> {
    const safeBranch = WorktreeManager.sanitiseBranchName(branch);
    const cwd = repoRootOverride ?? undefined;
    await this.execGit(['branch', '-D', safeBranch], cwd);
  }

  async removeWorktree(sessionId: string, repoRootOverride?: string): Promise<void> {
    WorktreeManager.assertNoInjection(sessionId, 'sessionId');
    const worktreePath = path.join(this.options.worktreesBaseDir, sessionId);
    const cwd = repoRootOverride ?? undefined;
    await this.execGit(['worktree', 'remove', '--force', worktreePath], cwd);
    await this.execGit(['worktree', 'prune'], cwd);
  }

  async listWorktrees(): Promise<WorktreeInfo[]> {
    const output = await this.execGit(['worktree', 'list', '--porcelain']);
    const blocks = output.trim().split(/\n\n+/);
    const results: WorktreeInfo[] = [];

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (block === undefined || block.trim() === '') continue;

      const lines = block.trim().split('\n');
      let worktreePath = '';
      let headSha = '';
      let branchRef = '';

      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          worktreePath = line.slice('worktree '.length);
        } else if (line.startsWith('HEAD ')) {
          headSha = line.slice('HEAD '.length);
        } else if (line.startsWith('branch ')) {
          branchRef = line.slice('branch '.length);
        }
      }

      // Filter out the main worktree (first block, path matches repoRoot)
      if (i === 0 && worktreePath === this.options.repoRoot) {
        continue;
      }

      const branch = branchRef.replace(/^refs\/heads\//, '');
      const id = path.basename(worktreePath);

      results.push({
        id,
        path: worktreePath,
        branch,
        commitSha: headSha,
        createdAt: new Date(),
      });
    }

    return results;
  }

  async worktreeExists(sessionId: string): Promise<boolean> {
    const worktrees = await this.listWorktrees();
    return worktrees.some((wt) => wt.path.endsWith(`/${sessionId}`));
  }

  /**
   * Fetches the latest refs from origin for a bare repo.
   * Tries directly on the bare path first; if chmod fails (Azure File Share),
   * falls back to staging in /tmp, fetching there, and copying back.
   */
  async fetchBareRepo(barePath: string): Promise<void> {
    // Bare clones don't set a fetch refspec by default, so pass one explicitly
    // to populate refs/remotes/origin/* for listRemoteBranches.
    const fetchArgs = ['fetch', 'origin', '+refs/heads/*:refs/remotes/origin/*'];
    try {
      await this.execGit(fetchArgs, barePath);
    } catch (directErr) {
      const errMsg = String(directErr);
      if (!errMsg.includes('EPERM') && !errMsg.includes('chmod')) {
        throw directErr;
      }
      // Azure File Share fallback: copy to /tmp, fetch there, copy back
      const stagingPath = path.join(os.tmpdir(), `orcha-fetch-${Date.now()}`);
      try {
        copyDirContents(barePath, stagingPath);
        await this.execGit(fetchArgs, stagingPath);
        // Copy updated refs back
        fs.rmSync(barePath, { recursive: true, force: true });
        copyDirContents(stagingPath, barePath);
      } finally {
        fs.rmSync(stagingPath, { recursive: true, force: true });
      }
    }
  }

  /**
   * Lists branches from a bare repo.
   * Tries refs/remotes/origin/ first (populated after fetchBareRepo with explicit refspec),
   * then falls back to refs/heads/ (default bare clone layout before first fetch).
   */
  async listRemoteBranches(barePath: string): Promise<string[]> {
    let output = await this.execGit(
      ['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin/'],
      barePath,
    );
    if (output.trim()) {
      return output
        .trim()
        .split('\n')
        .filter((line) => line.length > 0)
        .map((ref) => ref.replace(/^origin\//, ''));
    }
    // Fallback: bare clone refs/heads/ (before first fetch with refspec)
    output = await this.execGit(
      ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'],
      barePath,
    );
    return output
      .trim()
      .split('\n')
      .filter((line) => line.length > 0);
  }

  /**
   * Returns the default branch name (what HEAD points to) for a bare repo.
   */
  async getDefaultBranch(barePath: string): Promise<string | undefined> {
    try {
      const output = await this.execGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], barePath);
      // output like "refs/remotes/origin/main"
      return output.trim().replace(/^refs\/remotes\/origin\//, '');
    } catch {
      // Fallback: in a bare repo, HEAD points directly to the default branch
      try {
        const output = await this.execGit(['symbolic-ref', 'HEAD'], barePath);
        return output.trim().replace(/^refs\/heads\//, '');
      } catch {
        return undefined;
      }
    }
  }

  /**
   * Clones repoUrl as a bare repository into bareRepoDir/<repo-slug> if it
   * does not already exist, then returns the path to the bare repo.
   *
   * This supports the ephemeral-with-bare-repo hybrid storage strategy: the
   * bare object store persists on the mounted volume while working trees are
   * reconstructed on demand without requiring a full re-clone.
   */
  async ensureBareRepo(repoUrl: string): Promise<string> {
    WorktreeManager.assertNoInjection(repoUrl, 'repoUrl');

    const slug = repoUrl
      .replace(/^https?:\/\//, '')
      .replace(/^git@/, '')
      .replace(/:/g, '/')
      .replace(/\.git$/, '')
      .replace(/[^a-zA-Z0-9._/-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-/]+|[-/]+$/g, '');

    const bareRepoPath = path.join(getStoragePaths().bareRepoDir, slug);

    if (fs.existsSync(path.join(bareRepoPath, 'HEAD'))) {
      return bareRepoPath;
    }

    // Clean up any partial clone before (re-)cloning
    if (fs.existsSync(bareRepoPath)) {
      fs.rmSync(bareRepoPath, { recursive: true, force: true });
    }

    // Clone to a local staging dir first. Azure File Share (SMB) doesn't support
    // chmod, which git calls when writing its config file. /tmp is local SSD and
    // has full POSIX support. We copy the completed bare repo to /data afterwards.
    const stagingPath = path.join(os.tmpdir(), `orcha-clone-${Date.now()}`);
    fs.mkdirSync(stagingPath, { recursive: true });

    try {
      await new Promise<void>((resolve, reject) => {
        execFile(
          'git',
          ['clone', '--bare', repoUrl, stagingPath],
          {
            env: GIT_ENV,
            timeout: 5 * 60 * 1000,
          },
          (err, _stdout, stderr) => {
            if (err !== null) {
              reject(new WorktreeError(`git clone --bare failed: ${stderr}`, 'GIT_ERROR', err));
            } else {
              resolve();
            }
          },
        );
      });

      // fs.promises.cp calls chmod internally which fails on Azure File Share.
      // Use a plain read/write recursive copy instead.
      copyDirContents(stagingPath, bareRepoPath);
    } finally {
      fs.rmSync(stagingPath, { recursive: true, force: true });
    }

    return bareRepoPath;
  }
}
