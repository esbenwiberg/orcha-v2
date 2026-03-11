import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CleanupService } from './cleanup-service.js';
import type { CleanupResult } from './cleanup-service.js';

// ---------------------------------------------------------------------------
// Mock factory helpers
// ---------------------------------------------------------------------------

function makeDbSession(
  overrides: Partial<{
    id: string;
    instanceId: string;
    status: string;
    worktreePath: string;
  }> = {},
) {
  const id = overrides.id ?? 'session-id-1';
  const instanceId = overrides.instanceId ?? id;
  return {
    id,
    displayId: 1,
    instanceId,
    status: overrides.status ?? 'running',
    config: {
      instanceId,
      repoRoot: '/repo',
      branch: 'main',
      worktreePath: overrides.worktreePath ?? `/worktrees/${instanceId}`,
      prompt: '',
      env: {},
      maxRuntimeSeconds: 0,
    },
    worktree: {
      worktreePath: overrides.worktreePath ?? `/worktrees/${instanceId}`,
      branch: 'main',
      headSha: 'abc123',
      repoRoot: '/repo',
      createdAt: new Date(),
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeFsWorktreeDir(id: string, worktreePath?: string) {
  return {
    id,
    path: worktreePath ?? `/worktrees/${id}`,
  };
}

function makeMockSessionManager(overrides: Record<string, unknown> = {}) {
  return {
    getSession: vi.fn().mockReturnValue(undefined),
    listSessions: vi.fn().mockReturnValue([]),
    createSession: vi.fn(),
    stopSession: vi.fn(),
    stopAllSessions: vi.fn(),
    getOutputSnapshot: vi.fn(),
    ...overrides,
  };
}

function makeMockWorktreeManager(overrides: Record<string, unknown> = {}) {
  return {
    listWorktreeDirsOnDisk: vi.fn().mockReturnValue([]),
    removeOrphanedWorktreeDir: vi.fn(),
    pruneAllBareRepos: vi.fn().mockResolvedValue(undefined),
    listWorktrees: vi.fn().mockResolvedValue([]),
    removeWorktree: vi.fn().mockResolvedValue(undefined),
    addWorktree: vi.fn(),
    worktreeExists: vi.fn(),
    ...overrides,
  };
}

function makeMockSessionStore(overrides: Record<string, unknown> = {}) {
  return {
    listSessions: vi.fn().mockReturnValue([]),
    getSession: vi.fn(),
    getSessionByDisplayId: vi.fn(),
    createSession: vi.fn(),
    updateStatus: vi.fn().mockReturnValue({}),
    updateSession: vi.fn(),
    deleteSession: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CleanupService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // (a) runOnce marks a running DB session as failed when getSession returns undefined
  it('(a) runOnce marks stale running sessions as failed when no live PTY exists', async () => {
    const runningSession = makeDbSession({ id: 'sess-1', instanceId: 'sess-1', status: 'running' });
    const sessionManager = makeMockSessionManager({
      getSession: vi.fn().mockReturnValue(undefined), // no live PTY
    });
    const worktreeManager = makeMockWorktreeManager();
    const sessionStore = makeMockSessionStore({
      listSessions: vi.fn().mockReturnValue([runningSession]),
    });

    const svc = new CleanupService(
      sessionManager as never,
      worktreeManager as never,
      sessionStore as never,
    );

    const result = await svc.runOnce();

    expect(sessionStore.updateStatus).toHaveBeenCalledWith('sess-1', 'failed');
    expect(result.staleSessionsMarked).toContain('sess-1');
    expect(result.errors).toHaveLength(0);
  });

  // (b) runOnce removes orphaned worktree dirs with no corresponding active DB session
  it('(b) runOnce removes orphaned worktrees that have no active DB session', async () => {
    const fsDir = makeFsWorktreeDir('orphan-wt', '/worktrees/orphan-wt');
    const sessionManager = makeMockSessionManager();
    const worktreeManager = makeMockWorktreeManager({
      listWorktreeDirsOnDisk: vi.fn().mockReturnValue([fsDir]),
    });
    const sessionStore = makeMockSessionStore({
      // No DB sessions at all
      listSessions: vi.fn().mockReturnValue([]),
    });

    const svc = new CleanupService(
      sessionManager as never,
      worktreeManager as never,
      sessionStore as never,
    );

    const result = await svc.runOnce();

    expect(worktreeManager.removeOrphanedWorktreeDir).toHaveBeenCalledWith('orphan-wt');
    expect(worktreeManager.pruneAllBareRepos).toHaveBeenCalled();
    expect(result.orphanedWorktreesRemoved).toContain('/worktrees/orphan-wt');
    expect(result.errors).toHaveLength(0);
  });

  // (c) removeOrphanedWorktreeDir failure is recorded in errors and remaining orphans are still processed
  it('(c) removeWorktree failure is recorded in errors and remaining orphans are still processed', async () => {
    const dir1 = makeFsWorktreeDir('orphan-1', '/worktrees/orphan-1');
    const dir2 = makeFsWorktreeDir('orphan-2', '/worktrees/orphan-2');
    const sessionManager = makeMockSessionManager();
    const removeOrphanedWorktreeDir = vi.fn()
      .mockImplementationOnce(() => { throw new Error('rm failed'); })
      .mockImplementationOnce(() => { /* success */ });
    const worktreeManager = makeMockWorktreeManager({
      listWorktreeDirsOnDisk: vi.fn().mockReturnValue([dir1, dir2]),
      removeOrphanedWorktreeDir,
    });
    const sessionStore = makeMockSessionStore({
      listSessions: vi.fn().mockReturnValue([]),
    });

    const svc = new CleanupService(
      sessionManager as never,
      worktreeManager as never,
      sessionStore as never,
    );

    const result = await svc.runOnce();

    expect(removeOrphanedWorktreeDir).toHaveBeenCalledTimes(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ sessionId: 'orphan-1', error: expect.stringContaining('rm failed') });
    expect(result.orphanedWorktreesRemoved).toContain('/worktrees/orphan-2');
    expect(result.orphanedWorktreesRemoved).not.toContain('/worktrees/orphan-1');
  });

  // (d) start() causes _runCleanup to fire after intervalMs
  it('(d) start() fires cleanup after the interval elapses', async () => {
    const sessionManager = makeMockSessionManager();
    const worktreeManager = makeMockWorktreeManager();
    const sessionStore = makeMockSessionStore();

    const svc = new CleanupService(
      sessionManager as never,
      worktreeManager as never,
      sessionStore as never,
      1000,
    );

    // Spy on runOnce
    const runOnceSpy = vi.spyOn(svc, 'runOnce').mockResolvedValue({
      scannedAt: new Date(),
      orphanedWorktreesRemoved: [],
      staleSessionsMarked: [],
      errors: [],
    });

    svc.start();

    // The immediate call on start() counts as one invocation
    // Wait for the microtask queue to flush the fire-and-forget promise
    await Promise.resolve();

    const callsAfterStart = runOnceSpy.mock.calls.length;
    expect(callsAfterStart).toBeGreaterThanOrEqual(1);

    // Advance past one interval
    await vi.advanceTimersByTimeAsync(1000);
    expect(runOnceSpy.mock.calls.length).toBeGreaterThan(callsAfterStart);

    svc.stop();
  });

  // (e) stop() clears the interval so no further cleanups fire
  it('(e) stop() prevents further cleanup runs after being called', async () => {
    const sessionManager = makeMockSessionManager();
    const worktreeManager = makeMockWorktreeManager();
    const sessionStore = makeMockSessionStore();

    const svc = new CleanupService(
      sessionManager as never,
      worktreeManager as never,
      sessionStore as never,
      1000,
    );

    const runOnceSpy = vi.spyOn(svc, 'runOnce').mockResolvedValue({
      scannedAt: new Date(),
      orphanedWorktreesRemoved: [],
      staleSessionsMarked: [],
      errors: [],
    });

    svc.start();
    await Promise.resolve(); // flush the initial fire-and-forget

    svc.stop();

    const countAfterStop = runOnceSpy.mock.calls.length;

    // Advance well past multiple intervals
    await vi.advanceTimersByTimeAsync(5000);

    // No new calls should have been made after stop()
    expect(runOnceSpy.mock.calls.length).toBe(countAfterStop);
  });

  // (f) runOnce emits 'cleanup-complete' with the result when called via _runCleanup (start path)
  it('(f) cleanup-complete event is emitted with the result object after a cleanup run', async () => {
    const sessionManager = makeMockSessionManager();
    const worktreeManager = makeMockWorktreeManager();
    const sessionStore = makeMockSessionStore();

    const svc = new CleanupService(
      sessionManager as never,
      worktreeManager as never,
      sessionStore as never,
      1000,
    );

    const receivedResults: CleanupResult[] = [];
    svc.on('cleanup-complete', (r) => receivedResults.push(r));

    // Trigger _runCleanup indirectly by advancing the timer after start
    const runOnceSpy = vi.spyOn(svc, 'runOnce').mockResolvedValue({
      scannedAt: new Date(),
      orphanedWorktreesRemoved: ['path/to/wt'],
      staleSessionsMarked: ['stale-id'],
      errors: [],
    });

    svc.start();
    // Flush the immediate fire-and-forget (does NOT emit 'cleanup-complete')
    await Promise.resolve();
    await Promise.resolve();

    // Advance the interval to trigger _runCleanup
    await vi.advanceTimersByTimeAsync(1000);
    // Flush microtasks for the async _runCleanup
    await Promise.resolve();
    await Promise.resolve();

    expect(runOnceSpy).toHaveBeenCalled();
    expect(receivedResults.length).toBeGreaterThanOrEqual(1);
    expect(receivedResults[0]).toMatchObject({
      orphanedWorktreesRemoved: ['path/to/wt'],
      staleSessionsMarked: ['stale-id'],
    });

    svc.stop();
  });
});
