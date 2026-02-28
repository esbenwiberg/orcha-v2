import { homedir } from 'node:os';
import type { SandboxConfig } from './sandbox-config.js';

/**
 * Builds a sandboxed command based on the active sandbox mode.
 *
 * landlock (default):
 *   Uses landlock-exec, a small static C binary compiled into the image.
 *   Applies Linux Landlock LSM restrictions — no privileges or user namespaces
 *   required. Works in unprivileged ACA containers.
 *   Allowed RW: worktree, ~/.claude, /tmp, any extraRwPaths
 *   Allowed RO: /usr /lib /lib64 /bin /sbin /etc /proc /run
 *
 * bwrap (legacy, requires user namespaces or SUID):
 *   Uses bubblewrap for mount-namespace isolation. Does not work in ACA
 *   (no_new_privs + user namespaces restricted). Left for environments
 *   where bwrap is available.
 *
 * none: returns command unchanged.
 */
export function buildSandboxedCommand(
  worktreePath: string,
  command: string[],
  config: SandboxConfig,
  homeDir?: string,
  extraRwPaths: string[] = [],
): string[] {
  if (!config.enabled) return command;

  // Use os.homedir() (reads /etc/passwd for the current uid) rather than
  // process.env.HOME — Docker doesn't update HOME when switching users, so
  // process.env.HOME may be /root even when the process runs as a different
  // user whose actual home (and ~/.claude dir) is elsewhere.
  const home = homeDir ?? homedir();

  if (config.mode === 'landlock') {
    // landlock-exec <worktree> <home-dir> [extra-rw...] -- <command...>
    return [
      'landlock-exec',
      worktreePath,
      home,
      ...extraRwPaths,
      '--',
      ...command,
    ];
  }

  if (config.mode === 'bwrap') {
    const claudeConfigDir = `${home}/.claude`;
    return [
      'bwrap',
      '--ro-bind', '/usr', '/usr',
      '--ro-bind', '/lib', '/lib',
      '--ro-bind-try', '/lib64', '/lib64',
      '--ro-bind', '/bin', '/bin',
      '--ro-bind', '/etc/resolv.conf', '/etc/resolv.conf',
      '--ro-bind-try', '/etc/ssl', '/etc/ssl',
      '--ro-bind-try', '/etc/ca-certificates', '/etc/ca-certificates',
      '--bind', worktreePath, '/workspace',
      '--bind-try', claudeConfigDir, claudeConfigDir,
      '--tmpfs', '/tmp',
      '--chdir', '/workspace',
      '--unshare-pid',
      '--new-session',
      '--die-with-parent',
      '--',
      ...command,
    ];
  }

  return command;
}
