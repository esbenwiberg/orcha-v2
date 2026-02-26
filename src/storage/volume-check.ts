import fs from 'node:fs/promises';
import path from 'node:path';

export interface VolumeMountResult {
  persistent: boolean;
  warning: string | null;
}

export async function checkVolumeMount(dir: string): Promise<VolumeMountResult> {
  if (process.platform !== 'linux') {
    return { persistent: false, warning: null };
  }

  try {
    const content = await fs.readFile('/proc/mounts', 'utf8');
    const lines = content.split('\n');

    // Normalise dir to remove trailing slash for comparison
    const normDir = dir.endsWith('/') && dir.length > 1 ? dir.slice(0, -1) : dir;

    for (const line of lines) {
      const parts = line.split(' ');
      // /proc/mounts format: <device> <mountpoint> <fstype> <options> <dump> <pass>
      const mountpoint = parts[1];
      if (mountpoint === normDir) {
        return { persistent: true, warning: null };
      }
    }

    return {
      persistent: false,
      warning: `WARNING: ${path.normalize(dir)} is not a persistent mount — SQLite and worktrees will be lost on container restart`,
    };
  } catch {
    return {
      persistent: false,
      warning: `WARNING: ${path.normalize(dir)} is not a persistent mount — SQLite and worktrees will be lost on container restart`,
    };
  }
}
