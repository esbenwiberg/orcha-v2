import { execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { getStoragePaths } from '../storage/paths.js';

// Git env applied to all git subprocesses.
// - safe.directory=* suppresses the "dubious ownership" check that fires when
//   the repo on Azure File Share is presented with a different UID than the
//   running process.
// - core.fileMode=false prevents git from seeing file mode changes on Azure
//   File Share (SMB reports all files as 0777).
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'safe.directory',
  GIT_CONFIG_VALUE_0: '*',
  GIT_CONFIG_KEY_1: 'core.fileMode',
  GIT_CONFIG_VALUE_1: 'false',
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

/**
 * Ensures a bare repo's config file has core.fileMode = false.
 * When git clones to /tmp (full POSIX), it auto-detects fileMode support and
 * sets core.fileMode = true. Worktrees inherit this per-repo setting, which
 * overrides the user's global ~/.gitconfig. On Azure File Share (SMB) this
 * causes git to see phantom file mode changes on every file.
 */
function ensureFileModeDisabled(bareRepoPath: string): void {
  const configPath = path.join(bareRepoPath, 'config');
  if (!fs.existsSync(configPath)) return;
  let config = fs.readFileSync(configPath, 'utf8');
  // Already disabled — nothing to do
  if (/fileMode\s*=\s*false/i.test(config)) return;
  // Replace existing fileMode = true with false
  if (/fileMode\s*=\s*true/i.test(config)) {
    config = config.replace(/fileMode\s*=\s*true/i, 'fileMode = false');
  } else if (/\[core\]/i.test(config)) {
    // [core] section exists but no fileMode — add it
    config = config.replace(/(\[core\])/i, '$1\n\tfileMode = false');
  } else {
    // No [core] section at all — append one
    config += '\n[core]\n\tfileMode = false\n';
  }
  fs.writeFileSync(configPath, config, 'utf8');
}

/**
 * Ensures a bare repo's config has push.autoSetupRemote = true.
 * This lets `git push` in worktrees auto-create the upstream tracking branch,
 * avoiding the "no upstream branch" error on first push of a new branch.
 */
function ensureAutoSetupRemote(bareRepoPath: string): void {
  const configPath = path.join(bareRepoPath, 'config');
  if (!fs.existsSync(configPath)) return;
  let config = fs.readFileSync(configPath, 'utf8');
  // Already set — nothing to do
  if (/autoSetupRemote\s*=\s*true/i.test(config)) return;
  // Replace existing false with true
  if (/autoSetupRemote\s*=\s*false/i.test(config)) {
    config = config.replace(/autoSetupRemote\s*=\s*false/i, 'autoSetupRemote = true');
  } else if (/\[push\]/i.test(config)) {
    // [push] section exists but no autoSetupRemote — add it
    config = config.replace(/(\[push\])/i, '$1\n\tautoSetupRemote = true');
  } else {
    // No [push] section — append one
    config += '\n[push]\n\tautoSetupRemote = true\n';
  }
  fs.writeFileSync(configPath, config, 'utf8');
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

  /**
   * Removes any existing worktree that has `branch` checked out.
   * Git refuses to check out a branch in two worktrees simultaneously. Stale
   * worktrees from dead sessions can linger, so we evict them before adding a
   * new worktree for the same branch.
   */
  private async evictBranchFromWorktrees(branch: string, cwdOverride?: string): Promise<void> {
    let output: string;
    try {
      output = await this.execGit(['worktree', 'list', '--porcelain'], cwdOverride);
    } catch {
      return; // can't list worktrees — nothing to evict
    }

    const blocks = output.trim().split(/\n\n+/);
    for (const block of blocks) {
      const lines = block.trim().split('\n');
      let wtPath = '';
      let wtBranch = '';
      for (const line of lines) {
        if (line.startsWith('worktree ')) wtPath = line.slice('worktree '.length);
        if (line.startsWith('branch ')) wtBranch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
      }
      if (wtBranch === branch && wtPath) {
        console.warn('[worktree] branch %s already checked out at %s — evicting stale worktree', branch, wtPath);
        try {
          await this.execGit(['worktree', 'remove', '--force', wtPath], cwdOverride);
        } catch { /* directory may not exist or git may not track it */ }
        if (fs.existsSync(wtPath)) {
          fs.rmSync(wtPath, { recursive: true, force: true });
        }
        try { await this.execGit(['worktree', 'prune'], cwdOverride); } catch { /* best-effort */ }
      }
    }
  }

  /**
   * Creates a worktree that checks out an existing remote branch (no new local branch).
   * Used for PR review sessions where we want to work directly on the PR branch.
   */
  async checkoutWorktree(sessionId: string, remoteBranch: string, repoRootOverride?: string): Promise<WorktreeInfo> {
    WorktreeManager.assertNoInjection(sessionId, 'sessionId');
    WorktreeManager.assertNoInjection(remoteBranch, 'remoteBranch');
    const worktreePath = path.join(this.options.worktreesBaseDir, sessionId);
    const cwd = repoRootOverride ?? undefined;

    // Always prune stale worktree entries first (cleans up entries where
    // the on-disk directory was removed but git still tracks them).
    try { await this.execGit(['worktree', 'prune'], cwd); } catch { /* best-effort */ }

    // Clean up stale directory for THIS session's path
    if (fs.existsSync(worktreePath)) {
      console.warn('[worktree] stale directory %s exists — removing before checkoutWorktree', worktreePath);
      try {
        await this.execGit(['worktree', 'remove', '--force', worktreePath], cwd);
      } catch { /* git may not track it */ }
      if (fs.existsSync(worktreePath)) {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      }
    }

    // Strip origin/ prefix if present for the local branch name
    const localBranch = remoteBranch.replace(/^origin\//, '');
    const trackingRef = remoteBranch.startsWith('origin/') ? remoteBranch : `origin/${remoteBranch}`;

    // If the target branch is already checked out in another worktree (stale
    // session that wasn't cleaned up), remove that worktree first.
    await this.evictBranchFromWorktrees(localBranch, cwd);

    // Check if local branch already exists
    let branchExists = false;
    try {
      const raw = await this.execGit(['branch', '--list', '--no-color', localBranch], cwd);
      branchExists = raw.trim().length > 0;
    } catch { /* non-fatal */ }

    if (branchExists) {
      // Local branch exists — check it out directly
      await this.execGit(['worktree', 'add', worktreePath, localBranch], cwd);
      // Fast-forward to latest remote
      try {
        await this.execGit(['merge', '--ff-only', trackingRef], worktreePath);
      } catch { /* non-fatal — may diverge, that's OK */ }
    } else {
      // Create local branch tracking remote
      await this.execGit(['worktree', 'add', '-b', localBranch, worktreePath, trackingRef], cwd);
    }

    const commitShaRaw = await this.execGit(['rev-parse', 'HEAD'], worktreePath);
    const commitSha = commitShaRaw.trim();
    return {
      id: sessionId,
      path: worktreePath,
      branch: localBranch,
      commitSha,
      createdAt: new Date(),
    };
  }

  async addWorktree(sessionId: string, branch: string, repoRootOverride?: string, startPoint?: string): Promise<WorktreeInfo> {
    WorktreeManager.assertNoInjection(sessionId, 'sessionId');
    const safeBranch = WorktreeManager.sanitiseBranchName(branch);
    const worktreePath = path.join(this.options.worktreesBaseDir, sessionId);
    const cwd = repoRootOverride ?? undefined;

    // Clean up stale state: if the directory already exists from a previous
    // failed attempt (crash, timeout, partial cleanup), remove it and prune
    // git's worktree tracking so the new `git worktree add` succeeds.
    // Use `git worktree remove --force` first to properly unregister, then
    // fall back to rmSync + prune if git doesn't know about the worktree.
    if (fs.existsSync(worktreePath)) {
      console.warn('[worktree] stale directory %s exists — removing before addWorktree', worktreePath);
      try {
        await this.execGit(['worktree', 'remove', '--force', worktreePath], cwd);
      } catch { /* git may not track it — fall back to manual cleanup */ }
      if (fs.existsSync(worktreePath)) {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      }
      try {
        await this.execGit(['worktree', 'prune'], cwd);
      } catch { /* best-effort */ }
    } else {
      // Path doesn't exist, but git may still have a stale tracking entry
      try {
        await this.execGit(['worktree', 'prune'], cwd);
      } catch { /* best-effort */ }
    }

    // In a bare repo, HEAD points to the commit at clone time and is never
    // updated by fetchBareRepo (which only writes refs/remotes/origin/*).
    // If no explicit startPoint is given, resolve the default branch and use
    // the remote-tracking ref so the worktree gets the latest fetched commit.
    let resolvedStartPoint = startPoint;
    if (resolvedStartPoint === undefined && repoRootOverride !== undefined) {
      const defaultBranch = await this.getDefaultBranch(repoRootOverride);
      if (defaultBranch) {
        resolvedStartPoint = `origin/${defaultBranch}`;
      }
    }

    // Prune stale worktree entries first so `git branch` doesn't show `+`
    // prefix for worktrees whose directories no longer exist.
    try { await this.execGit(['worktree', 'prune'], cwd); } catch { /* best-effort */ }

    // Auto-suffix branch name if it already exists (e.g. fork from a completed session)
    let finalBranch = safeBranch;
    const existingBranches = new Set<string>();
    try {
      const raw = await this.execGit(['branch', '--list', '--no-color'], cwd);
      for (const line of raw.split('\n')) {
        const name = line.replace(/^[*+]?\s+/, '').trim();
        if (name) existingBranches.add(name);
      }
    } catch {
      // Non-fatal — if we can't list branches, just try the original name
    }
    if (existingBranches.has(finalBranch)) {
      let suffix = 2;
      while (existingBranches.has(`${safeBranch}-${suffix}`)) {
        suffix++;
      }
      finalBranch = `${safeBranch}-${suffix}`;
    }

    const args = ['worktree', 'add', '-b', finalBranch, worktreePath];
    if (resolvedStartPoint !== undefined) {
      WorktreeManager.assertNoInjection(resolvedStartPoint, 'startPoint');
      args.push(resolvedStartPoint);
    }
    await this.execGit(args, cwd);
    const commitShaRaw = await this.execGit(['rev-parse', 'HEAD'], worktreePath);
    const commitSha = commitShaRaw.trim();
    return {
      id: sessionId,
      path: worktreePath,
      branch: finalBranch,
      commitSha,
      createdAt: new Date(),
    };
  }

  /**
   * Restores a worktree from an existing branch (e.g. after container restart).
   * Prunes stale worktree entries, then re-adds the worktree without creating a new branch.
   */
  async restoreWorktree(sessionId: string, branch: string, repoRootOverride?: string): Promise<WorktreeInfo> {
    WorktreeManager.assertNoInjection(sessionId, 'sessionId');
    const safeBranch = WorktreeManager.sanitiseBranchName(branch);
    const worktreePath = path.join(this.options.worktreesBaseDir, sessionId);
    const cwd = repoRootOverride ?? undefined;

    // Prune stale worktree entries first
    try { await this.execGit(['worktree', 'prune'], cwd); } catch { /* best-effort */ }

    // Clean stale entries and leftover directories
    if (fs.existsSync(worktreePath)) {
      console.warn('[worktree] stale directory %s exists — removing before restoreWorktree', worktreePath);
      try {
        await this.execGit(['worktree', 'remove', '--force', worktreePath], cwd);
      } catch { /* git may not track it */ }
      if (fs.existsSync(worktreePath)) {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      }
    }

    // Evict branch from any stale worktree that still has it checked out
    await this.evictBranchFromWorktrees(safeBranch, cwd);

    // Add worktree from existing branch (no -b flag)
    await this.execGit(['worktree', 'add', worktreePath, safeBranch], cwd);

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
   * Lists worktree directories on disk by scanning the worktreesBaseDir filesystem.
   * Unlike listWorktrees() this does NOT require a valid git repo — it's purely
   * filesystem-based and works across all bare repos.
   */
  listWorktreeDirsOnDisk(): Array<{ id: string; path: string }> {
    const dir = this.options.worktreesBaseDir;
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ id: d.name, path: path.join(dir, d.name) }));
  }

  /**
   * Removes an orphaned worktree directory (no DB session).
   * Does NOT prune git references — call pruneAllBareRepos() once after
   * all orphan removals for efficiency.
   */
  removeOrphanedWorktreeDir(sessionId: string): void {
    WorktreeManager.assertNoInjection(sessionId, 'sessionId');
    const worktreePath = path.join(this.options.worktreesBaseDir, sessionId);
    if (fs.existsSync(worktreePath)) {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
  }

  /**
   * Runs `git worktree prune` on every bare repo in the storage directory.
   * Cleans up stale worktree references left behind after directory removal.
   */
  async pruneAllBareRepos(): Promise<void> {
    const bareRepoDir = getStoragePaths().bareRepoDir;
    if (!fs.existsSync(bareRepoDir)) return;
    const entries = fs.readdirSync(bareRepoDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const repoPath = path.join(bareRepoDir, entry.name);
      // Only prune if it looks like a bare repo
      if (!fs.existsSync(path.join(repoPath, 'HEAD'))) continue;
      try {
        await this.execGit(['worktree', 'prune'], repoPath);
      } catch {
        // Best-effort — skip repos that fail
      }
    }
  }

  /**
   * Fetches the latest refs from origin for a bare repo.
   * Tries directly on the bare path first; if chmod fails (Azure File Share),
   * falls back to staging in /tmp, fetching there, and copying back.
   */
  private fetchCache = new Map<string, number>();
  private static readonly FETCH_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

  async fetchBareRepo(barePath: string, opts?: { skipCache?: boolean }): Promise<void> {
    const now = Date.now();
    if (!opts?.skipCache) {
      const lastFetch = this.fetchCache.get(barePath);
      if (lastFetch && now - lastFetch < WorktreeManager.FETCH_CACHE_TTL_MS) {
        return;
      }
    }

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
    // Fast-forward the default branch's local ref (e.g. refs/heads/main) to
    // match origin. Without this, worktrees see a stale `main` from clone-time
    // when running `git diff main...HEAD` — making it look like 150+ commits
    // diverged when there's really just 1.
    try {
      const defaultBranch = await this.getDefaultBranch(barePath);
      if (defaultBranch) {
        await this.execGit(
          ['update-ref', `refs/heads/${defaultBranch}`, `refs/remotes/origin/${defaultBranch}`],
          barePath,
        );
      }
    } catch {
      // Best-effort: may fail if the branch is checked out in a worktree
    }

    this.fetchCache.set(barePath, Date.now());
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
      // Patch existing repos that were cloned before these config fixes
      ensureFileModeDisabled(bareRepoPath);
      ensureAutoSetupRemote(bareRepoPath);
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

      // Patch bare repo config while still on /tmp (before copying to Azure
      // Files where chmod would fail).
      ensureFileModeDisabled(stagingPath);
      ensureAutoSetupRemote(stagingPath);

      // fs.promises.cp calls chmod internally which fails on Azure File Share.
      // Use a plain read/write recursive copy instead.
      copyDirContents(stagingPath, bareRepoPath);
    } finally {
      fs.rmSync(stagingPath, { recursive: true, force: true });
    }

    return bareRepoPath;
  }
}
