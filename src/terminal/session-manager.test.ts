import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { SessionManager } from './session-manager.js';
import type { WorktreeInfo } from './worktree-manager.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeWorktreeInfo(sessionId: string): WorktreeInfo {
  return {
    id: sessionId,
    path: `/tmp/worktrees/${sessionId}`,
    branch: 'feature-branch',
    commitSha: 'abc123',
    createdAt: new Date(),
  };
}

/** A mock terminal that is an EventEmitter with an `output` EventEmitter. */
class MockTerminal extends EventEmitter {
  readonly sessionId: string;
  readonly pid: number | undefined = 99;
  readonly exitCode: number | undefined = undefined;

  // output is an EventEmitter that also acts as a ReadableStream for 'data' events
  readonly output: EventEmitter = new EventEmitter();

  readonly write = vi.fn();
  readonly resize = vi.fn();
  readonly kill = vi.fn<[signal?: string], void>();

  constructor(sessionId: string) {
    super();
    this.sessionId = sessionId;
  }

  /** Helper to simulate PTY output data */
  _emitData(data: string): void {
    this.output.emit('data', Buffer.from(data));
  }

  /** Helper to simulate PTY exit */
  _emitExit(code: number, signal = ''): void {
    this.emit('exit', code, signal);
  }
}

function makeMockWorktreeManager(overrides?: Partial<Record<string, unknown>>) {
  return {
    addWorktree: vi.fn(),
    removeWorktree: vi.fn().mockResolvedValue(undefined),
    listWorktrees: vi.fn().mockResolvedValue([]),
    worktreeExists: vi.fn().mockResolvedValue(false),
    ...overrides,
  };
}

function makeMockPtyManager(terminal: MockTerminal) {
  return {
    spawn: vi.fn().mockReturnValue(terminal),
    get: vi.fn(),
    killAll: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockSessionStore() {
  return {
    createSession: vi.fn().mockReturnValue({ id: 'db-id', status: 'pending' }),
    updateStatus: vi.fn().mockReturnValue({ id: 'db-id', status: 'running' }),
    updateSession: vi.fn().mockReturnValue({ id: 'db-id' }),
    getSession: vi.fn(),
    listSessions: vi.fn().mockReturnValue([]),
    deleteSession: vi.fn(),
    getSessionByDisplayId: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionManager', () => {
  let terminal: MockTerminal;
  let worktreeManager: ReturnType<typeof makeMockWorktreeManager>;
  let ptyManager: ReturnType<typeof makeMockPtyManager>;
  let sessionStore: ReturnType<typeof makeMockSessionStore>;
  let manager: SessionManager;

  beforeEach(() => {
    terminal = new MockTerminal('test-session');
    worktreeManager = makeMockWorktreeManager({
      addWorktree: vi.fn().mockResolvedValue(makeWorktreeInfo('test-session')),
    });
    ptyManager = makeMockPtyManager(terminal);
    sessionStore = makeMockSessionStore();

    manager = new SessionManager(
      worktreeManager as never,
      ptyManager as never,
      sessionStore as never,
    );
  });

  // (a) createSession calls addWorktree then ptyManager.spawn, returns ActiveSession
  it('(a) createSession calls addWorktree then spawn, returns ActiveSession', async () => {
    const session = await manager.createSession({
      sessionId: 'test-session',
      branch: 'feature-branch',
      command: 'bash',
    });

    expect(worktreeManager.addWorktree).toHaveBeenCalledWith('test-session', 'feature-branch', undefined, undefined);
    expect(ptyManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'test-session',
        cwd: `/tmp/worktrees/test-session`,
        command: 'bash',
        size: { cols: 220, rows: 50 },
      }),
    );
    expect(session.sessionId).toBe('test-session');
    expect(session.worktree).toBeDefined();
    expect(session.terminal).toBe(terminal);
    expect(session.outputBuffer).toBeDefined();
    expect(session.createdAt).toBeInstanceOf(Date);
  });

  // (b) if addWorktree throws, createSession rethrows SessionError WORKTREE_FAILED, does NOT call spawn
  it('(b) addWorktree failure throws WORKTREE_FAILED and does not call spawn', async () => {
    worktreeManager.addWorktree = vi.fn().mockRejectedValue(new Error('git error'));

    await expect(
      manager.createSession({ sessionId: 'fail-wt', branch: 'main', command: 'bash' }),
    ).rejects.toMatchObject({
      code: 'WORKTREE_FAILED',
    });

    expect(ptyManager.spawn).not.toHaveBeenCalled();
  });

  // (c) if spawn throws, createSession calls removeWorktree for rollback and rethrows SessionError PTY_FAILED
  it('(c) spawn failure triggers rollback removeWorktree and throws PTY_FAILED', async () => {
    worktreeManager.addWorktree = vi.fn().mockResolvedValue(makeWorktreeInfo('fail-pty'));
    ptyManager.spawn = vi.fn().mockImplementation(() => {
      throw new Error('spawn error');
    });

    await expect(
      manager.createSession({ sessionId: 'fail-pty', branch: 'main', command: 'bash' }),
    ).rejects.toMatchObject({
      code: 'PTY_FAILED',
    });

    expect(worktreeManager.removeWorktree).toHaveBeenCalledWith('fail-pty');
  });

  // (d) stopSession calls kill('SIGTERM') and session disappears from listSessions after mock terminal fires 'exit'
  it('(d) stopSession kills terminal and session is removed from listSessions after exit', async () => {
    await manager.createSession({
      sessionId: 'stop-session',
      branch: 'main',
      command: 'bash',
    });

    expect(manager.listSessions()).toHaveLength(1);

    // Start stop (it will wait for exit event), then trigger exit from the mock terminal
    const stopPromise = manager.stopSession('stop-session');

    // Allow the stop to register its exit listener
    await Promise.resolve();

    // Simulate terminal exiting
    terminal._emitExit(0);

    await stopPromise;

    // After _handleExit runs, session should be removed
    // Give the async handler a tick to execute
    await Promise.resolve();

    expect(manager.listSessions()).toHaveLength(0);
  });

  // (e) createSession twice with same sessionId throws SessionError DUPLICATE_SESSION
  it('(e) createSession with duplicate sessionId throws DUPLICATE_SESSION', async () => {
    await manager.createSession({ sessionId: 'dup-session', branch: 'main', command: 'bash' });

    // Reset spawn so it doesn't complain about the terminal mock being reused
    ptyManager.spawn = vi.fn().mockReturnValue(new MockTerminal('dup-session'));
    worktreeManager.addWorktree = vi.fn().mockResolvedValue(makeWorktreeInfo('dup-session'));

    await expect(
      manager.createSession({ sessionId: 'dup-session', branch: 'main', command: 'bash' }),
    ).rejects.toMatchObject({
      code: 'DUPLICATE_SESSION',
    });
  });

  // (f) getOutputSnapshot returns buffer contents after simulated PTY data events
  it('(f) getOutputSnapshot returns accumulated output from PTY data events', async () => {
    await manager.createSession({
      sessionId: 'test-session',
      branch: 'main',
      command: 'bash',
    });

    terminal._emitData('hello ');
    terminal._emitData('world');

    const snapshot = manager.getOutputSnapshot('test-session');
    expect(snapshot.toString()).toBe('hello world');
  });

  // (g) DB upsert/create called with running status on create, update called with stopped status after exit
  it('(g) DB createSession called on create and updateStatus called with completed after exit', async () => {
    await manager.createSession({
      sessionId: 'test-session',
      branch: 'main',
      command: 'bash',
    });

    expect(sessionStore.createSession).toHaveBeenCalledOnce();
    // SessionStore.createSession returns { id: 'db-id', ... }; subsequent calls use
    // the DB id, not the terminal sessionId.
    expect(sessionStore.updateStatus).toHaveBeenCalledWith('db-id', 'starting');
    expect(sessionStore.updateStatus).toHaveBeenCalledWith('db-id', 'running');

    // Simulate exit
    terminal._emitExit(0);

    // Give the async _handleExit a tick
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(sessionStore.updateStatus).toHaveBeenCalledWith('db-id', 'completed');
    expect(sessionStore.updateSession).toHaveBeenCalledWith('db-id', { exitCode: 0 });
  });

  // Additional: getOutputSnapshot throws NOT_FOUND for unknown sessions
  it('getOutputSnapshot throws NOT_FOUND for unknown sessionId', () => {
    expect(() => manager.getOutputSnapshot('nonexistent')).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
  });

  // Additional: stopSession throws NOT_FOUND for unknown session
  it('stopSession throws NOT_FOUND for unknown sessionId', async () => {
    await expect(manager.stopSession('nonexistent')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  // Additional: stopAllSessions settles without throwing even if sessions fail
  it('stopAllSessions calls stop on all active sessions', async () => {
    await manager.createSession({
      sessionId: 'test-session',
      branch: 'main',
      command: 'bash',
    });

    // Fire and forget — just check it completes
    const allSettledPromise = manager.stopAllSessions();
    await Promise.resolve();
    terminal._emitExit(0);
    await allSettledPromise;

    expect(terminal.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
