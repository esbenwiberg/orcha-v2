import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from './connection.js';
import { runMigrations } from './migrate.js';
import { InstanceRegistry } from './instance-registry.js';
import { SessionStore } from './session-store.js';
import type { SessionConfig, WorktreeInfo, SessionStatus } from '@orcha/domain';

const MIGRATIONS_DIR = 'src/db/migrations';

const testInstanceId = 'test-instance-id';

const makeConfig = (instanceId: string): SessionConfig => ({
  instanceId,
  repoRoot: '/repo',
  branch: 'main',
  worktreePath: '/worktrees/session',
  prompt: 'test',
  env: {},
  maxRuntimeSeconds: 3600,
});

const makeWorktree = (worktreePath: string): WorktreeInfo => ({
  worktreePath,
  branch: 'main',
  headSha: 'abc123',
  repoRoot: '/repo',
  createdAt: new Date(),
});

describe('Business invariants', () => {
  let db: Database.Database;
  let registry: InstanceRegistry;
  let store: SessionStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    registry = new InstanceRegistry(db);
    store = new SessionStore(db);
  });

  it('Session must reference a registered instance (FK enforcement)', () => {
    const unregisteredId = crypto.randomUUID();
    const config = makeConfig(unregisteredId);
    const worktree = makeWorktree(config.worktreePath);
    expect(() => store.createSession(config, worktree)).toThrow();
  });

  it('Session worktree path must be consistent with config worktreePath', () => {
    registry.registerInstance({
      id: testInstanceId,
      repoRoot: '/repo',
      registeredAt: new Date(),
      lastSeenAt: new Date(),
    });

    const config = makeConfig(testInstanceId);
    const worktree = makeWorktree(config.worktreePath);
    const session = store.createSession(config, worktree);

    const retrieved = store.getSession(session.id);
    expect(retrieved).toBeDefined();
    expect(retrieved?.worktree.worktreePath).toBe(retrieved?.config.worktreePath);
  });

  it('No-overwrite guard: registering the same instance twice throws', () => {
    registry.registerInstance({
      id: testInstanceId,
      repoRoot: '/repo',
      registeredAt: new Date(),
      lastSeenAt: new Date(),
    });

    expect(() =>
      registry.registerInstance({
        id: testInstanceId,
        repoRoot: '/repo/other',
        registeredAt: new Date(),
        lastSeenAt: new Date(),
      }),
    ).toThrow(testInstanceId);

    expect(registry.listInstances()).toHaveLength(1);
  });

  it('Full status lifecycle: pending → starting → running → completed', () => {
    registry.registerInstance({
      id: testInstanceId,
      repoRoot: '/repo',
      registeredAt: new Date(),
      lastSeenAt: new Date(),
    });

    const session = store.createSession(
      makeConfig(testInstanceId),
      makeWorktree('/worktrees/session'),
    );
    expect(session.status).toBe('pending');

    const starting = store.updateStatus(session.id, 'starting');
    expect(starting.status).toBe('starting');

    const running = store.updateStatus(session.id, 'running');
    expect(running.status).toBe('running');
    expect(running.startedAt).toBeInstanceOf(Date);

    const completed = store.updateStatus(session.id, 'completed');
    expect(completed.status).toBe('completed');
    expect(completed.completedAt).toBeInstanceOf(Date);
  });

  it('Invalid status transition is rejected and leaves status unchanged', () => {
    registry.registerInstance({
      id: testInstanceId,
      repoRoot: '/repo',
      registeredAt: new Date(),
      lastSeenAt: new Date(),
    });

    const session = store.createSession(
      makeConfig(testInstanceId),
      makeWorktree('/worktrees/session'),
    );

    expect(() => store.updateStatus(session.id, 'completed')).toThrow(TypeError);

    expect(store.getSession(session.id)?.status).toBe('pending');
  });

  it('Terminal status is final: no further transitions from completed', () => {
    registry.registerInstance({
      id: testInstanceId,
      repoRoot: '/repo',
      registeredAt: new Date(),
      lastSeenAt: new Date(),
    });

    const session = store.createSession(
      makeConfig(testInstanceId),
      makeWorktree('/worktrees/session'),
    );
    store.updateStatus(session.id, 'starting');
    store.updateStatus(session.id, 'running');
    store.updateStatus(session.id, 'completed');

    const otherStatuses: SessionStatus[] = [
      'pending',
      'starting',
      'running',
      'paused',
      'failed',
      'cancelled',
    ];
    for (const status of otherStatuses) {
      expect(() => store.updateStatus(session.id, status)).toThrow(TypeError);
    }

    expect(store.getSession(session.id)?.status).toBe('completed');
  });

  it('Status events are recorded for every valid transition', () => {
    registry.registerInstance({
      id: testInstanceId,
      repoRoot: '/repo',
      registeredAt: new Date(),
      lastSeenAt: new Date(),
    });

    const session = store.createSession(
      makeConfig(testInstanceId),
      makeWorktree('/worktrees/session'),
    );
    const id = session.id;

    store.updateStatus(id, 'starting');
    store.updateStatus(id, 'running');
    store.updateStatus(id, 'failed');

    const events = db
      .prepare('SELECT * FROM status_events WHERE session_id = ? ORDER BY id ASC')
      .all(id) as Array<{ from_status: string; to_status: string }>;

    expect(events).toHaveLength(3);
    expect(events[0]?.from_status).toBe('pending');
    expect(events[0]?.to_status).toBe('starting');
    expect(events[1]?.from_status).toBe('starting');
    expect(events[1]?.to_status).toBe('running');
    expect(events[2]?.from_status).toBe('running');
    expect(events[2]?.to_status).toBe('failed');
  });

  it('deleteSession removes session and all its status events', () => {
    registry.registerInstance({
      id: testInstanceId,
      repoRoot: '/repo',
      registeredAt: new Date(),
      lastSeenAt: new Date(),
    });

    const session = store.createSession(
      makeConfig(testInstanceId),
      makeWorktree('/worktrees/session'),
    );
    const id = session.id;

    store.updateStatus(id, 'starting');
    store.updateStatus(id, 'running');

    store.deleteSession(id);

    expect(store.getSession(id)).toBeUndefined();

    const events = db.prepare('SELECT * FROM status_events WHERE session_id = ?').all(id);
    expect(events).toHaveLength(0);
  });
});
