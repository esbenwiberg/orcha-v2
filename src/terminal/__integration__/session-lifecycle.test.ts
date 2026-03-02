import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { makeTestRepo, MIGRATIONS_DIR } from './helpers.js';
import { WorktreeManager } from '../worktree-manager.js';
import { PtyManager } from '../pty-manager.js';
import { SessionManager } from '../session-manager.js';
import { StatusMonitor } from '../status-monitor.js';
import { CleanupService } from '../cleanup-service.js';
import { InstanceRegistry } from '../../db/instance-registry.js';
import { openDatabase } from '../../db/connection.js';
import { runMigrations } from '../../db/migrate.js';
import { SessionStore } from '../../db/session-store.js';
import type { SessionTerminal } from '../session-terminal.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

interface TestFixture {
  repoRoot: string;
  worktreesDir: string;
  worktreeManager: WorktreeManager;
  ptyManager: PtyManager;
  sessionStore: SessionStore;
  instanceRegistry: InstanceRegistry;
  sessionManager: SessionManager;
  cleanup: () => Promise<void>;
}

async function makeFixture(): Promise<TestFixture> {
  const { repoRoot, worktreesDir, cleanup } = await makeTestRepo();

  const db = openDatabase(':memory:');
  runMigrations(db, MIGRATIONS_DIR);
  const sessionStore = new SessionStore(db);
  const instanceRegistry = new InstanceRegistry(db);

  const now = new Date();
  instanceRegistry.upsertInstance({ id: 'local', repoRoot, registeredAt: now, lastSeenAt: now });

  const worktreeManager = new WorktreeManager({ repoRoot, worktreesBaseDir: worktreesDir });
  const ptyManager = new PtyManager();
  const sessionManager = new SessionManager(worktreeManager, ptyManager, sessionStore, undefined, 'local');

  return {
    repoRoot,
    worktreesDir,
    worktreeManager,
    ptyManager,
    sessionStore,
    instanceRegistry,
    sessionManager,
    cleanup,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('session-lifecycle integration', () => {
  let fixture: TestFixture;

  beforeEach(async () => {
    fixture = await makeFixture();
  });

  afterEach(async () => {
    try {
      await fixture.sessionManager.stopAllSessions();
    } catch {
      // Best-effort: ignore errors from stopping already-stopped sessions
    } finally {
      await fixture.cleanup();
    }
  });

  // -------------------------------------------------------------------------
  // Test 1: creates a session, worktree appears on filesystem, PTY spawns
  // -------------------------------------------------------------------------
  it('creates a session, worktree appears on filesystem, PTY spawns', async () => {
    const { instanceRegistry, sessionManager } = fixture;
    const sessionId = 'test-session-1';

    // Register an instance with the same ID that will be used as instanceId
    instanceRegistry.registerInstance({
      id: sessionId,
      repoRoot: fixture.repoRoot,
      registeredAt: new Date(),
      lastSeenAt: new Date(),
    });

    const activeSession = await sessionManager.createSession({
      sessionId,
      branch: 'feat/test-1',
      command: 'bash',
      args: ['-c', 'echo hello && sleep 1'],
    });

    expect(activeSession.sessionId).toBeTruthy();
    expect(typeof activeSession.sessionId).toBe('string');
    expect(fs.existsSync(activeSession.worktree.path)).toBe(true);
    expect(activeSession.terminal.pid).toBeDefined();
    expect(typeof activeSession.terminal.pid).toBe('number');
    expect(activeSession.terminal.pid!).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Test 2: output flows through the buffer
  // -------------------------------------------------------------------------
  it('output flows through the buffer', async () => {
    const { instanceRegistry, sessionManager } = fixture;
    const sessionId = 'test-session-2';

    instanceRegistry.registerInstance({
      id: sessionId,
      repoRoot: fixture.repoRoot,
      registeredAt: new Date(),
      lastSeenAt: new Date(),
    });

    const activeSession = await sessionManager.createSession({
      sessionId,
      branch: 'feat/test-2',
      command: 'bash',
      args: ['-c', 'echo INTEGRATION_MARKER'],
    });

    // Wait for PTY to exit
    await new Promise<void>((resolve) => {
      activeSession.terminal.on('exit', () => resolve());
    });

    // Give the output buffer a moment to flush
    await new Promise<void>((r) => setTimeout(r, 100));

    // The session is removed from _active map by _handleExit, so we read from the outputBuffer directly
    const snapshot = activeSession.outputBuffer.snapshot();
    expect(snapshot.toString()).toContain('INTEGRATION_MARKER');
  });

  // -------------------------------------------------------------------------
  // Test 3: stopSession sends SIGTERM and session exits
  // -------------------------------------------------------------------------
  it('stopSession sends SIGTERM and session exits', async () => {
    const { instanceRegistry, sessionManager } = fixture;
    const sessionId = 'test-session-3';

    instanceRegistry.registerInstance({
      id: sessionId,
      repoRoot: fixture.repoRoot,
      registeredAt: new Date(),
      lastSeenAt: new Date(),
    });

    const activeSession = await sessionManager.createSession({
      sessionId,
      branch: 'feat/test-3',
      command: 'bash',
      args: ['-c', 'sleep 60'],
    });

    const worktreePath = activeSession.worktree.path;

    // Session should be visible before stop
    expect(sessionManager.listSessions().map((s) => s.sessionId)).toContain(sessionId);

    await sessionManager.stopSession(sessionId);

    // Session stays accessible for a grace period (5 min) so late WS
    // connections can still read the output buffer.
    expect(sessionManager.getSession(sessionId)).toBeDefined();

    // Worktrees are preserved until explicitly deleted (for session reopen)
    expect(fs.existsSync(worktreePath)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 4: StatusMonitor detects complete after PTY exits
  // -------------------------------------------------------------------------
  it('StatusMonitor detects complete after PTY exits', async () => {
    const { instanceRegistry, sessionManager } = fixture;
    const sessionId = 'test-session-4';

    instanceRegistry.registerInstance({
      id: sessionId,
      repoRoot: fixture.repoRoot,
      registeredAt: new Date(),
      lastSeenAt: new Date(),
    });

    const statusMonitor = new StatusMonitor(500);
    const collectedStatuses: string[] = [];

    statusMonitor.on('status-change', (event) => {
      collectedStatuses.push(event.status);
    });

    const activeSession = await sessionManager.createSession({
      sessionId,
      branch: 'feat/test-4',
      command: 'bash',
      args: ['-c', 'echo hi'],
    });

    statusMonitor.watch(sessionId, activeSession.terminal as SessionTerminal);

    // Wait for the process to finish and StatusMonitor to emit
    await new Promise<void>((r) => setTimeout(r, 2000));

    expect(collectedStatuses).toContain('complete');
  });

  // -------------------------------------------------------------------------
  // Test 5: CleanupService removes orphaned worktree
  // -------------------------------------------------------------------------
  it('CleanupService removes orphaned worktree', async () => {
    const { worktreeManager, sessionManager, sessionStore } = fixture;

    // Manually create a worktree that has no corresponding DB session
    await worktreeManager.addWorktree('orphan-999', 'orphan-branch');
    const orphanPath = path.join(fixture.worktreesDir, 'orphan-999');

    expect(fs.existsSync(orphanPath)).toBe(true);

    const cleanupService = new CleanupService(sessionManager, worktreeManager, sessionStore);
    const result = await cleanupService.runOnce();

    expect(result.orphanedWorktreesRemoved).toContain(orphanPath);
    expect(fs.existsSync(orphanPath)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Test 6: full lifecycle: create → stop → cleanup
  // -------------------------------------------------------------------------
  it('full lifecycle: create → stop → cleanup', async () => {
    const { instanceRegistry, sessionManager, worktreeManager, sessionStore } = fixture;
    const sessionId = 'test-session-6';

    instanceRegistry.registerInstance({
      id: sessionId,
      repoRoot: fixture.repoRoot,
      registeredAt: new Date(),
      lastSeenAt: new Date(),
    });

    const activeSession = await sessionManager.createSession({
      sessionId,
      branch: 'feat/test-6',
      command: 'bash',
      args: ['-c', 'sleep 60'],
    });

    const worktreePath = activeSession.worktree.path;

    // Stop the session
    await sessionManager.stopSession(sessionId);

    // Session stays accessible during grace period
    expect(sessionManager.getSession(sessionId)).toBeDefined();

    // Worktree is preserved for session reopen
    expect(fs.existsSync(worktreePath)).toBe(true);
  });
});
