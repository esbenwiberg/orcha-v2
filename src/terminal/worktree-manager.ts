import { execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { getStoragePaths } from '../storage/paths.js';

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
      execFile('git', args, { cwd }, (err, stdout, stderr) => {
        if (err !== null) {
          reject(new WorktreeError(`git ${args[0]} failed: ${stderr}`, 'GIT_ERROR', err));
        } else {
          resolve(stdout);
        }
      });
    });
  }

  async addWorktree(sessionId: string, branch: string, repoRootOverride?: string): Promise<WorktreeInfo> {
    WorktreeManager.assertNoInjection(sessionId, 'sessionId');
    const safeBranch = WorktreeManager.sanitiseBranchName(branch);
    const worktreePath = path.join(this.options.worktreesBaseDir, sessionId);
    const cwd = repoRootOverride ?? undefined;
    await this.execGit(['worktree', 'add', '-b', safeBranch, worktreePath], cwd);
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
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
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

      fs.mkdirSync(bareRepoPath, { recursive: true });
      await fs.promises.cp(stagingPath, bareRepoPath, { recursive: true });
    } finally {
      fs.rmSync(stagingPath, { recursive: true, force: true });
    }

    return bareRepoPath;
  }
}
