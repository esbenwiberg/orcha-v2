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
 *   Allowed RO: /usr /lib /lib64 /bin /sbin /etc /proc /run /opt
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

  return command;
}
