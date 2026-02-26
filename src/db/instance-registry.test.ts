import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from './connection.js';
import { runMigrations } from './migrate.js';
import { InstanceRegistry } from './instance-registry.js';

const MIGRATIONS_DIR = 'src/db/migrations';

describe('InstanceRegistry', () => {
  let db: Database.Database;
  let registry: InstanceRegistry;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    registry = new InstanceRegistry(db);
  });

  it('(a) listInstances returns empty array on fresh db', () => {
    expect(registry.listInstances()).toEqual([]);
  });

  it('(b) registerInstance returns InstanceInfo with activeSessions === 0 and ISO-parseable date fields', () => {
    const now = new Date();
    const info = registry.registerInstance({
      id: 'inst-1',
      repoRoot: '/home/user/repo',
      registeredAt: now,
      lastSeenAt: now,
    });

    expect(info.activeSessions).toBe(0);
    expect(info.registeredAt).toBeInstanceOf(Date);
    expect(info.lastSeenAt).toBeInstanceOf(Date);
    expect(isNaN(info.registeredAt.getTime())).toBe(false);
    expect(isNaN(info.lastSeenAt.getTime())).toBe(false);
  });

  it('(c) listInstances after one registration returns exactly one item', () => {
    const now = new Date();
    registry.registerInstance({
      id: 'inst-1',
      repoRoot: '/home/user/repo',
      registeredAt: now,
      lastSeenAt: now,
    });

    const list = registry.listInstances();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('inst-1');
  });

  it('(d) registerInstance with same id throws TypeError containing the id', () => {
    const now = new Date();
    registry.registerInstance({
      id: 'inst-dup',
      repoRoot: '/home/user/repo',
      registeredAt: now,
      lastSeenAt: now,
    });

    expect(() =>
      registry.registerInstance({
        id: 'inst-dup',
        repoRoot: '/home/user/other',
        registeredAt: now,
        lastSeenAt: now,
      }),
    ).toThrow(TypeError);
    expect(() =>
      registry.registerInstance({
        id: 'inst-dup',
        repoRoot: '/home/user/other',
        registeredAt: now,
        lastSeenAt: now,
      }),
    ).toThrow('inst-dup');
  });

  it('(e) getInstance with registered id returns correct object', () => {
    const now = new Date();
    registry.registerInstance({
      id: 'inst-e',
      repoRoot: '/home/user/repo-e',
      registeredAt: now,
      lastSeenAt: now,
    });

    const found = registry.getInstance('inst-e');
    expect(found).toBeDefined();
    expect(found?.id).toBe('inst-e');
    expect(found?.repoRoot).toBe('/home/user/repo-e');
    expect(found?.activeSessions).toBe(0);
  });

  it('(f) getInstance with unknown id returns undefined', () => {
    expect(registry.getInstance('no-such-id')).toBeUndefined();
  });

  it('(g) unregisterInstance removes row so getInstance returns undefined', () => {
    const now = new Date();
    registry.registerInstance({
      id: 'inst-g',
      repoRoot: '/home/user/repo-g',
      registeredAt: now,
      lastSeenAt: now,
    });

    registry.unregisterInstance('inst-g');
    expect(registry.getInstance('inst-g')).toBeUndefined();
  });

  it('(h) unregisterInstance with unknown id throws TypeError', () => {
    expect(() => registry.unregisterInstance('ghost-id')).toThrow(TypeError);
    expect(() => registry.unregisterInstance('ghost-id')).toThrow('ghost-id');
  });
});
