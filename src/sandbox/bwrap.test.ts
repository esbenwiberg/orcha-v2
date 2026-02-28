import { describe, it, expect } from 'vitest';
import { buildSandboxedCommand } from './bwrap.js';
import type { SandboxConfig } from './sandbox-config.js';

const disabledConfig: SandboxConfig = {
  enabled: false,
  mode: 'none',
};

const bwrapConfig: SandboxConfig = {
  enabled: true,
  mode: 'bwrap',
};

describe('buildSandboxedCommand', () => {
  it('returns command unchanged when mode is none', () => {
    const cmd = ['bash', '-c', 'echo hi'];
    const result = buildSandboxedCommand('/workspace/foo', cmd, disabledConfig);
    expect(result).toEqual(cmd);
  });

  it('wraps command with bwrap when mode is bwrap', () => {
    const cmd = ['claude', '--dangerously-skip-permissions'];
    const result = buildSandboxedCommand('/workspace/foo', cmd, bwrapConfig, '/home/orcha');

    expect(result[0]).toBe('bwrap');
    expect(result).toContain('--bind');
    expect(result).toContain('/workspace/foo');
    expect(result).toContain('--tmpfs');
    expect(result).toContain('/tmp');

    // The original command must appear at the end
    const claudeIdx = result.lastIndexOf('claude');
    expect(claudeIdx).toBeGreaterThan(0);
    expect(result[claudeIdx + 1]).toBe('--dangerously-skip-permissions');
  });

  it('includes /workspace as the mount target', () => {
    const result = buildSandboxedCommand('/my/worktree', ['bash'], bwrapConfig, '/home/orcha');
    const bindIdx = result.indexOf('--bind');
    expect(bindIdx).toBeGreaterThan(0);
    expect(result[bindIdx + 1]).toBe('/my/worktree');
    expect(result[bindIdx + 2]).toBe('/workspace');
  });

  it('mounts the .claude config dir at its real path', () => {
    const result = buildSandboxedCommand('/my/worktree', ['bash'], bwrapConfig, '/home/orcha');
    expect(result).toContain('/home/orcha/.claude');
  });
});
