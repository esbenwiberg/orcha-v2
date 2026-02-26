import { describe, expect, it } from 'vitest';
import { assertValidTransition, isValidTransition, type Session } from './index.js';

describe('isValidTransition', () => {
  it('returns true for valid transition pending → starting', () => {
    expect(isValidTransition('pending', 'starting')).toBe(true);
  });

  it('returns false for invalid transition completed → running', () => {
    expect(isValidTransition('completed', 'running')).toBe(false);
  });
});

describe('assertValidTransition', () => {
  it('does not throw for valid transition running → failed', () => {
    expect(() => assertValidTransition('running', 'failed')).not.toThrow();
  });

  it('throws TypeError for invalid transition completed → running', () => {
    expect(() => assertValidTransition('completed', 'running')).toThrow(TypeError);
    expect(() => assertValidTransition('completed', 'running')).toThrow('completed → running');
  });
});

describe('Session type', () => {
  it('valid Session object literal satisfies the Session type', () => {
    const session = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      displayId: 1,
      instanceId: 'inst-1',
      status: 'running' as const,
      config: {
        instanceId: 'inst-1',
        repoRoot: '/home/user/repo',
        branch: 'main',
        worktreePath: '/home/user/repo/.worktrees/session-1',
        prompt: 'Implement feature X',
        env: { NODE_ENV: 'production' },
        maxRuntimeSeconds: 3600,
      },
      worktree: {
        worktreePath: '/home/user/repo/.worktrees/session-1',
        branch: 'main',
        headSha: 'abc123def456',
        repoRoot: '/home/user/repo',
        createdAt: new Date('2026-02-26T00:00:00Z'),
      },
      createdAt: new Date('2026-02-26T00:00:00Z'),
      updatedAt: new Date('2026-02-26T00:01:00Z'),
    } satisfies Session;

    expect(session.id).toBe('550e8400-e29b-41d4-a716-446655440000');
  });
});
