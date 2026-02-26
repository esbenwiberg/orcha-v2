import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import { WorktreeManager, WorktreeError } from './worktree-manager.js';

vi.mock('node:child_process');

const mockExecFile = vi.mocked(execFile);

const OPTIONS = {
  repoRoot: '/home/user/repo',
  worktreesBaseDir: '/home/user/repo/.worktrees',
};

describe('WorktreeManager', () => {
  let manager: WorktreeManager;

  beforeEach(() => {
    manager = new WorktreeManager(OPTIONS);
    vi.clearAllMocks();
  });

  it('(a) addWorktree returns correct WorktreeInfo shape', async () => {
    let callCount = 0;
    mockExecFile.mockImplementation((_file, _args, _opts, callback) => {
      callCount++;
      if (callCount === 1) {
        // git worktree add
        (callback as (err: null, stdout: string, stderr: string) => void)(null, '', '');
      } else {
        // git rev-parse HEAD
        (callback as (err: null, stdout: string, stderr: string) => void)(
          null,
          'abc123\n',
          '',
        );
      }
      return {} as ReturnType<typeof execFile>;
    });

    const info = await manager.addWorktree('session-1', 'feat/my feature');
    expect(info.id).toBe('session-1');
    expect(info.path).toBe('/home/user/repo/.worktrees/session-1');
    expect(info.branch).toBe('feat/my-feature');
    expect(info.commitSha).toBe('abc123');
    expect(info.createdAt).toBeInstanceOf(Date);
  });

  it('(b) sanitiseBranchName strips forbidden characters from "feat/my session!@#"', async () => {
    let callCount = 0;
    mockExecFile.mockImplementation((_file, args, _opts, callback) => {
      callCount++;
      if (callCount === 1) {
        // Capture the branch name passed as args[3]
        const branchArg = (args as string[])[3];
        expect(branchArg).toBe('feat/my-session-');
        (callback as (err: null, stdout: string, stderr: string) => void)(null, '', '');
      } else {
        (callback as (err: null, stdout: string, stderr: string) => void)(null, 'deadbeef\n', '');
      }
      return {} as ReturnType<typeof execFile>;
    });

    const info = await manager.addWorktree('session-2', 'feat/my session!@#');
    expect(info.branch).toBe('feat/my-session-');
  });

  it('(c) assertNoInjection throws WorktreeError with code INJECTION_ATTEMPT when value contains "$("', async () => {
    await expect(manager.addWorktree('$(rm -rf /)', 'main')).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof WorktreeError && err.code === 'INJECTION_ATTEMPT',
    );
  });

  it('(d) removeWorktree calls execFile with worktree remove --force then worktree prune', async () => {
    const calls: string[][] = [];
    mockExecFile.mockImplementation((_file, args, _opts, callback) => {
      calls.push(args as string[]);
      (callback as (err: null, stdout: string, stderr: string) => void)(null, '', '');
      return {} as ReturnType<typeof execFile>;
    });

    await manager.removeWorktree('session-3');

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual([
      'worktree',
      'remove',
      '--force',
      '/home/user/repo/.worktrees/session-3',
    ]);
    expect(calls[1]).toEqual(['worktree', 'prune']);
  });

  it('(e) listWorktrees correctly parses porcelain output with main + one child worktree', async () => {
    const porcelainOutput = [
      'worktree /home/user/repo',
      'HEAD deadbeef1234',
      'branch refs/heads/main',
      '',
      'worktree /home/user/repo/.worktrees/session-4',
      'HEAD abc123def456',
      'branch refs/heads/feat/cool-feature',
      '',
    ].join('\n');

    mockExecFile.mockImplementation((_file, _args, _opts, callback) => {
      (callback as (err: null, stdout: string, stderr: string) => void)(
        null,
        porcelainOutput,
        '',
      );
      return {} as ReturnType<typeof execFile>;
    });

    const worktrees = await manager.listWorktrees();

    expect(worktrees).toHaveLength(1);
    expect(worktrees[0]).toMatchObject({
      id: 'session-4',
      path: '/home/user/repo/.worktrees/session-4',
      branch: 'feat/cool-feature',
      commitSha: 'abc123def456',
    });
    expect(worktrees[0]?.createdAt).toBeInstanceOf(Date);
  });
});
