import { describe, it, expect } from 'vitest';
import { buildSandboxedCommand } from './sandbox-command.js';
import type { SandboxConfig } from './sandbox-config.js';

const disabledConfig: SandboxConfig = { enabled: false, mode: 'none' };
const landlockConfig: SandboxConfig = { enabled: true, mode: 'landlock' };

describe('buildSandboxedCommand — disabled', () => {
  it('returns command unchanged when disabled', () => {
    const cmd = ['bash', '-c', 'echo hi'];
    expect(buildSandboxedCommand('/workspace/foo', cmd, disabledConfig)).toEqual(cmd);
  });
});

describe('buildSandboxedCommand — landlock mode', () => {
  it('uses landlock-exec as first arg', () => {
    const result = buildSandboxedCommand('/my/worktree', ['bash'], landlockConfig, '/home/orcha');
    expect(result[0]).toBe('landlock-exec');
  });

  it('passes worktree and home-dir as positional args', () => {
    const result = buildSandboxedCommand('/my/worktree', ['bash'], landlockConfig, '/home/orcha');
    expect(result[1]).toBe('/my/worktree');
    expect(result[2]).toBe('/home/orcha');
  });

  it('separates landlock args from command with --', () => {
    const result = buildSandboxedCommand('/my/worktree', ['bash', '-l'], landlockConfig, '/home/orcha');
    const sep = result.indexOf('--');
    expect(sep).toBeGreaterThan(0);
    expect(result[sep + 1]).toBe('bash');
    expect(result[sep + 2]).toBe('-l');
  });

  it('inserts extra RW paths before --', () => {
    const result = buildSandboxedCommand(
      '/my/worktree', ['bash'], landlockConfig, '/home/orcha',
      ['/mnt/shared', '/opt/tools'],
    );
    const sep = result.indexOf('--');
    const extraSection = result.slice(3, sep);
    expect(extraSection).toContain('/mnt/shared');
    expect(extraSection).toContain('/opt/tools');
  });
});
