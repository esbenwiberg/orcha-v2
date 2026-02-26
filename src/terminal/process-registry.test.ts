import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ProcessRegistry, _resetForTest } from './process-registry.js';
import type { ShutdownOptions } from './process-registry.js';

// ---------------------------------------------------------------------------
// Mock factory helpers
// ---------------------------------------------------------------------------

function makeMockSessionManager(overrides: Record<string, unknown> = {}) {
  return {
    stopAllSessions: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn(),
    stopSession: vi.fn(),
    getSession: vi.fn(),
    listSessions: vi.fn().mockReturnValue([]),
    getOutputSnapshot: vi.fn(),
    ...overrides,
  };
}

function makeMockCleanupService(overrides: Record<string, unknown> = {}) {
  return {
    stop: vi.fn(),
    runOnce: vi.fn().mockResolvedValue({
      scannedAt: new Date(),
      orphanedWorktreesRemoved: [],
      staleSessionsMarked: [],
      errors: [],
    }),
    start: vi.fn(),
    on: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProcessRegistry', () => {
  beforeEach(() => {
    process.env['NODE_ENV'] = 'test';
    _resetForTest();
  });

  afterEach(() => {
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
  });

  // (a) getInstance() returns the same object on repeated calls
  it('(a) getInstance() returns the same singleton instance on repeated calls', () => {
    const first = ProcessRegistry.getInstance();
    const second = ProcessRegistry.getInstance();
    expect(first).toBe(second);
  });

  // (b) register adds a manager so shutdown calls stopAllSessions on it
  it('(b) register adds a manager so _shutdown calls stopAllSessions on it', async () => {
    const registry = ProcessRegistry.getInstance();
    const manager = makeMockSessionManager();

    registry.register(manager as never);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    try {
      await (registry as unknown as { _shutdown: (c: undefined, o: ShutdownOptions) => Promise<void> })._shutdown(
        undefined,
        {},
      );
    } catch {
      // expected: process.exit throws in our mock
    }

    expect(manager.stopAllSessions).toHaveBeenCalledTimes(1);
    exitSpy.mockRestore();
  });

  // (b2) unregister removes a manager so shutdown does not call stopAllSessions on it
  it('(b2) unregister removes a manager so _shutdown does not call stopAllSessions on it', async () => {
    const registry = ProcessRegistry.getInstance();
    const manager = makeMockSessionManager();

    registry.register(manager as never);
    registry.unregister(manager as never);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    try {
      await (registry as unknown as { _shutdown: (c: undefined, o: ShutdownOptions) => Promise<void> })._shutdown(
        undefined,
        {},
      );
    } catch {
      // expected: process.exit throws in our mock
    }

    expect(manager.stopAllSessions).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  // (c) registerShutdownHandlers is idempotent — calling twice only adds one SIGTERM listener
  it('(c) registerShutdownHandlers is idempotent and registers SIGTERM only once', () => {
    const registry = ProcessRegistry.getInstance();

    const beforeCount = process.listenerCount('SIGTERM');
    registry.registerShutdownHandlers();
    registry.registerShutdownHandlers();

    expect(process.listenerCount('SIGTERM')).toBe(beforeCount + 1);
  });

  // (d) simulating shutdown calls stopAllSessions on every registered manager
  it('(d) _shutdown calls stopAllSessions on all registered managers', async () => {
    const registry = ProcessRegistry.getInstance();
    const manager1 = makeMockSessionManager();
    const manager2 = makeMockSessionManager();

    registry.register(manager1 as never);
    registry.register(manager2 as never);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    try {
      await (registry as unknown as { _shutdown: (c: undefined, o: ShutdownOptions) => Promise<void> })._shutdown(
        undefined,
        {},
      );
    } catch {
      // expected: process.exit throws in our mock
    }

    expect(manager1.stopAllSessions).toHaveBeenCalledTimes(1);
    expect(manager2.stopAllSessions).toHaveBeenCalledTimes(1);

    exitSpy.mockRestore();
  });

  // (e) if stopAllSessions rejects on one manager, _shutdown still calls it on remaining managers
  it('(e) _shutdown continues to drain remaining managers even if one stopAllSessions rejects', async () => {
    const registry = ProcessRegistry.getInstance();

    const failingManager = makeMockSessionManager({
      stopAllSessions: vi.fn().mockRejectedValue(new Error('PTY gone')),
    });
    const successManager = makeMockSessionManager();

    registry.register(failingManager as never);
    registry.register(successManager as never);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    try {
      await (registry as unknown as { _shutdown: (c: undefined, o: ShutdownOptions) => Promise<void> })._shutdown(
        undefined,
        {},
      );
    } catch {
      // expected: process.exit throws in our mock
    }

    expect(failingManager.stopAllSessions).toHaveBeenCalledTimes(1);
    expect(successManager.stopAllSessions).toHaveBeenCalledTimes(1);

    exitSpy.mockRestore();
  });

  // Bonus: _shutdown with runCleanupFirst calls cleanup.runOnce before draining managers
  it('runCleanupFirst option causes cleanup.runOnce to be called before draining', async () => {
    const registry = ProcessRegistry.getInstance();
    const cleanup = makeMockCleanupService();

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    try {
      await (
        registry as unknown as {
          _shutdown: (c: typeof cleanup, o: ShutdownOptions) => Promise<void>;
        }
      )._shutdown(cleanup as never, { runCleanupFirst: true });
    } catch {
      // expected: process.exit throws
    }

    expect(cleanup.stop).toHaveBeenCalledTimes(1);
    expect(cleanup.runOnce).toHaveBeenCalledTimes(1);

    exitSpy.mockRestore();
  });
});
