import type { SandboxConfig } from './sandbox-config.js';

/**
 * Wraps a command with bwrap + systemd-run for filesystem isolation
 * and optional cgroup resource limits.
 *
 * When mode is 'none', returns the command unchanged.
 */
export function buildSandboxedCommand(
  worktreePath: string,
  command: string[],
  config: SandboxConfig,
): string[] {
  if (!config.enabled || config.mode !== 'bwrap') {
    return command;
  }

  const systemdRun = [
    'systemd-run',
    '--scope',
    '--user',
    `-p`, `MemoryMax=${config.memoryMax}`,
    `-p`, `CPUQuota=${config.cpuQuota}`,
    '--',
  ];

  const bwrap = [
    'bwrap',
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/lib', '/lib',
    '--ro-bind', '/bin', '/bin',
    '--ro-bind', '/etc/resolv.conf', '/etc/resolv.conf',
    '--ro-bind', '/etc/ssl', '/etc/ssl',
    '--bind', worktreePath, '/workspace',
    '--chdir', '/workspace',
    '--unshare-pid',
    '--new-session',
    '--die-with-parent',
    '--',
    ...command,
  ];

  // Add /lib64 only if it exists (not present on all distros)
  const bwrapWithLib64 = [
    'bwrap',
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/lib', '/lib',
    '--ro-bind-try', '/lib64', '/lib64',
    '--ro-bind', '/bin', '/bin',
    '--ro-bind', '/etc/resolv.conf', '/etc/resolv.conf',
    '--ro-bind-try', '/etc/ssl', '/etc/ssl',
    '--ro-bind-try', '/etc/ca-certificates', '/etc/ca-certificates',
    '--bind', worktreePath, '/workspace',
    '--chdir', '/workspace',
    '--unshare-pid',
    '--new-session',
    '--die-with-parent',
    '--',
    ...command,
  ];

  void bwrap; // replaced by bwrapWithLib64 below for robustness

  return [...systemdRun, ...bwrapWithLib64];
}
