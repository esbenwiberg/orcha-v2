import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from './connection.js';
import { runMigrations } from './migrate.js';
import { InstanceRegistry } from './instance-registry.js';
import { SessionStore } from './session-store.js';
import type { SessionConfig, WorktreeInfo } from '@orcha/domain';

const MIGRATIONS_DIR = 'src/db/migrations';

const INSTANCE_ID = 'inst-test-1';

const BASE_CONFIG: SessionConfig = {
  instanceId: INSTANCE_ID,
  repoRoot: '/home/user/repo',
  branch: 'main',
  worktreePath: '/home/user/repo/.worktrees/session-1',
  prompt: 'Implement feature X',
  env: { NODE_ENV: 'test' },
  maxRuntimeSeconds: 3600,
};

const BASE_WORKTREE: WorktreeInfo = {
  worktreePath: '/home/user/repo/.worktrees/session-1',
  branch: 'main',
  headSha: 'abc123def456',
  repoRoot: '/home/user/repo',
  createdAt: new Date('2026-02-26T00:00:00Z'),
};

describe('SessionStore', () => {
  let db: Database.Database;
  let store: SessionStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    const registry = new InstanceRegistry(db);
    registry.registerInstance({
      id: INSTANCE_ID,
      repoRoot: '/home/user/repo',
      registeredAt: new Date(),
      lastSeenAt: new Date(),
    });
    store = new SessionStore(db);
  });

  it('(a) createSession returns Session with status===pending', () => {
    const session = store.createSession(BASE_CONFIG, BASE_WORKTREE);
    expect(session.status).toBe('pending');
    expect(session.instanceId).toBe(INSTANCE_ID);
    expect(session.displayId).toBe(1);
    expect(session.id).toBeTruthy();
    expect(session.config).toMatchObject(BASE_CONFIG);
    expect(session.worktree.headSha).toBe(BASE_WORKTREE.headSha);
    expect(session.createdAt).toBeInstanceOf(Date);
    expect(session.updatedAt).toBeInstanceOf(Date);
  });

  it('(b) getSession returns the created session', () => {
    const created = store.createSession(BASE_CONFIG, BASE_WORKTREE);
    const found = store.getSession(created.id);
    expect(found).toBeDefined();
    expect(found?.id).toBe(created.id);
    expect(found?.displayId).toBe(created.displayId);
    expect(found?.status).toBe('pending');
  });

  it('(c) getSessionByDisplayId returns same session', () => {
    const created = store.createSession(BASE_CONFIG, BASE_WORKTREE);
    const found = store.getSessionByDisplayId(created.displayId);
    expect(found).toBeDefined();
    expect(found?.id).toBe(created.id);
  });

  it('(d) listSessions without filter returns all sessions', () => {
    store.createSession(BASE_CONFIG, BASE_WORKTREE);
    store.createSession(BASE_CONFIG, BASE_WORKTREE);
    const list = store.listSessions();
    expect(list).toHaveLength(2);
  });

  it('(e) listSessions with instanceId filter returns only matching sessions', () => {
    const registry = new InstanceRegistry(db);
    const otherId = 'inst-other';
    registry.registerInstance({
      id: otherId,
      repoRoot: '/home/user/other',
      registeredAt: new Date(),
      lastSeenAt: new Date(),
    });

    store.createSession(BASE_CONFIG, BASE_WORKTREE);
    const otherConfig: SessionConfig = { ...BASE_CONFIG, instanceId: otherId };
    store.createSession(otherConfig, BASE_WORKTREE);

    const filtered = store.listSessions(INSTANCE_ID);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.instanceId).toBe(INSTANCE_ID);

    const otherFiltered = store.listSessions(otherId);
    expect(otherFiltered).toHaveLength(1);
    expect(otherFiltered[0]?.instanceId).toBe(otherId);
  });

  it('(f) updateStatus pending→running succeeds and sets startedAt', () => {
    const session = store.createSession(BASE_CONFIG, BASE_WORKTREE);
    // pending → starting → running
    store.updateStatus(session.id, 'starting');
    const running = store.updateStatus(session.id, 'running');
    expect(running.status).toBe('running');
    expect(running.startedAt).toBeInstanceOf(Date);
  });

  it('(g) updateStatus with invalid transition throws TypeError', () => {
    const session = store.createSession(BASE_CONFIG, BASE_WORKTREE);
    // pending → running is not a valid transition (must go through starting)
    expect(() => store.updateStatus(session.id, 'running')).toThrow(TypeError);
  });

  it('(h) updateStatus on non-existent id throws TypeError with id in message', () => {
    expect(() => store.updateStatus('no-such-id', 'starting')).toThrow(TypeError);
    expect(() => store.updateStatus('no-such-id', 'starting')).toThrow(
      'Session not found: no-such-id',
    );
  });

  it('(i) after updateStatus to terminal state, status_events has correct from and to', () => {
    const session = store.createSession(BASE_CONFIG, BASE_WORKTREE);
    store.updateStatus(session.id, 'starting');
    store.updateStatus(session.id, 'running');
    store.updateStatus(session.id, 'completed');

    const events = db
      .prepare('SELECT * FROM status_events WHERE session_id = ? ORDER BY id ASC')
      .all(session.id) as Array<{
      from_status: string;
      to_status: string;
      occurred_at: string;
      note: string | null;
    }>;

    expect(events).toHaveLength(3);
    expect(events[0]?.from_status).toBe('pending');
    expect(events[0]?.to_status).toBe('starting');
    expect(events[1]?.from_status).toBe('starting');
    expect(events[1]?.to_status).toBe('running');
    expect(events[2]?.from_status).toBe('running');
    expect(events[2]?.to_status).toBe('completed');
  });

  it('(j) deleteSession removes session and its status events', () => {
    const session = store.createSession(BASE_CONFIG, BASE_WORKTREE);
    store.updateStatus(session.id, 'starting');

    store.deleteSession(session.id);

    expect(store.getSession(session.id)).toBeUndefined();

    const events = db.prepare('SELECT * FROM status_events WHERE session_id = ?').all(session.id);
    expect(events).toHaveLength(0);
  });

  it('(k) two createSession calls produce unique displayId values', () => {
    const s1 = store.createSession(BASE_CONFIG, BASE_WORKTREE);
    const s2 = store.createSession(BASE_CONFIG, BASE_WORKTREE);
    expect(s1.displayId).not.toBe(s2.displayId);
    expect(s2.displayId).toBe(s1.displayId + 1);
  });

  it('getSession with unknown id returns undefined', () => {
    expect(store.getSession('no-such-id')).toBeUndefined();
  });

  it('getSessionByDisplayId with unknown displayId returns undefined', () => {
    expect(store.getSessionByDisplayId(9999)).toBeUndefined();
  });

  it('deleteSession on non-existent id throws TypeError', () => {
    expect(() => store.deleteSession('no-such-id')).toThrow(TypeError);
    expect(() => store.deleteSession('no-such-id')).toThrow('Session not found: no-such-id');
  });

  it('updateSession patches errorMessage and exitCode', () => {
    const session = store.createSession(BASE_CONFIG, BASE_WORKTREE);
    const updated = store.updateSession(session.id, { errorMessage: 'oops', exitCode: 1 });
    expect(updated.errorMessage).toBe('oops');
    expect(updated.exitCode).toBe(1);
  });

  it('worktree createdAt is deserialized as Date', () => {
    const session = store.createSession(BASE_CONFIG, BASE_WORKTREE);
    expect(session.worktree.createdAt).toBeInstanceOf(Date);
    expect(session.worktree.createdAt.toISOString()).toBe('2026-02-26T00:00:00.000Z');
  });

  it('reconcileOrphanedSessions marks running and starting sessions as failed', () => {
    const s1 = store.createSession(BASE_CONFIG, BASE_WORKTREE);
    store.updateStatus(s1.id, 'starting');
    store.updateStatus(s1.id, 'running');

    const s2 = store.createSession(BASE_CONFIG, BASE_WORKTREE);
    store.updateStatus(s2.id, 'starting');

    const s3 = store.createSession(BASE_CONFIG, BASE_WORKTREE);
    store.updateStatus(s3.id, 'starting');
    store.updateStatus(s3.id, 'running');
    store.updateStatus(s3.id, 'completed');

    const count = store.reconcileOrphanedSessions();
    expect(count).toBe(2);
    expect(store.getSession(s1.id)?.status).toBe('failed');
    expect(store.getSession(s2.id)?.status).toBe('failed');
    expect(store.getSession(s3.id)?.status).toBe('completed');
  });
});
