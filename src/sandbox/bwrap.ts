import type { SandboxConfig } from './sandbox-config.js';

/**
 * Wraps a command with bwrap for filesystem isolation.
 * The sandboxed process can only see:
 *   - /workspace  — the session worktree (writable)
 *   - $HOME/.claude — Claude settings/transcripts (writable)
 *   - /tmp         — tmpfs for scratch space
 *   - standard system dirs (read-only)
 *
 * Note: systemd-run is intentionally omitted — ACA containers have no systemd.
 * Resource limits (memory/CPU) are configured at the Container App level instead.
 *
 * When mode is 'none', returns the command unchanged.
 */
export function buildSandboxedCommand(
  worktreePath: string,
  command: string[],
  config: SandboxConfig,
  homeDir?: string,
): string[] {
  if (!config.enabled || config.mode !== 'bwrap') {
    return command;
  }

  const home = homeDir ?? process.env['HOME'] ?? '/root';
  const claudeConfigDir = `${home}/.claude`;

  const bwrap = [
    'bwrap',
    // System dirs (read-only)
    '--ro-bind', '/usr', '/usr',
    '--ro-bind', '/lib', '/lib',
    '--ro-bind-try', '/lib64', '/lib64',
    '--ro-bind', '/bin', '/bin',
    '--ro-bind', '/etc/resolv.conf', '/etc/resolv.conf',
    '--ro-bind-try', '/etc/ssl', '/etc/ssl',
    '--ro-bind-try', '/etc/ca-certificates', '/etc/ca-certificates',
    // Session worktree (writable — the agent's working directory)
    '--bind', worktreePath, '/workspace',
    // Claude config dir (writable — settings.json, CLAUDE.md, session JSONL transcripts)
    '--bind-try', claudeConfigDir, claudeConfigDir,
    // Scratch space
    '--tmpfs', '/tmp',
    '--chdir', '/workspace',
    '--unshare-pid',
    '--new-session',
    '--die-with-parent',
    '--',
    ...command,
  ];

  return bwrap;
}
