import { describe, it, expect } from 'vitest';
import { buildSandboxedCommand } from './bwrap.js';
import type { SandboxConfig } from './sandbox-config.js';

const disabledConfig: SandboxConfig = {
  enabled: false,
  mode: 'none',
  memoryMax: '512M',
  cpuQuota: '100%',
};

const bwrapConfig: SandboxConfig = {
  enabled: true,
  mode: 'bwrap',
  memoryMax: '512M',
  cpuQuota: '50%',
};

describe('buildSandboxedCommand', () => {
  it('returns command unchanged when mode is none', () => {
    const cmd = ['bash', '-c', 'echo hi'];
    const result = buildSandboxedCommand('/workspace/foo', cmd, disabledConfig);
    expect(result).toEqual(cmd);
  });

  it('wraps command with systemd-run and bwrap when mode is bwrap', () => {
    const cmd = ['claude', '--dangerously-skip-permissions'];
    const result = buildSandboxedCommand('/workspace/foo', cmd, bwrapConfig);

    expect(result[0]).toBe('systemd-run');
    expect(result).toContain('bwrap');
    expect(result).toContain('--bind');
    expect(result).toContain('/workspace/foo');
    expect(result).toContain('MemoryMax=512M');
    expect(result).toContain('CPUQuota=50%');

    // The original command must appear at the end
    const claudeIdx = result.lastIndexOf('claude');
    expect(claudeIdx).toBeGreaterThan(0);
    expect(result[claudeIdx + 1]).toBe('--dangerously-skip-permissions');
  });

  it('includes /workspace as the mount target', () => {
    const result = buildSandboxedCommand('/my/worktree', ['bash'], bwrapConfig);
    const bindIdx = result.indexOf('--bind');
    expect(bindIdx).toBeGreaterThan(0);
    expect(result[bindIdx + 1]).toBe('/my/worktree');
    expect(result[bindIdx + 2]).toBe('/workspace');
  });
});
