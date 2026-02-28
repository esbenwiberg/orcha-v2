import { execSync } from 'node:child_process';

export type SandboxMode = 'landlock' | 'bwrap' | 'none';

export interface SandboxConfig {
  enabled: boolean;
  mode: SandboxMode;
}

let _config: SandboxConfig | undefined;

function testLandlock(): boolean {
  try {
    // Run a no-op command through landlock-exec to verify the binary exists
    // and the kernel supports Landlock (or at least that it fails gracefully).
    execSync('landlock-exec /tmp /tmp -- /bin/true', {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

function testBwrap(): boolean {
  try {
    execSync(
      'bwrap --ro-bind /usr /usr --ro-bind-try /lib /lib --ro-bind-try /bin /bin --unshare-pid --die-with-parent -- /bin/true',
      { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 },
    );
    return true;
  } catch {
    return false;
  }
}

export function loadSandboxConfig(): SandboxConfig {
  if (_config !== undefined) return _config;

  const requested = (process.env['SANDBOX_MODE'] ?? 'none') as SandboxMode;

  let mode = requested;
  if (requested === 'landlock' && !testLandlock()) {
    console.warn('[sandbox] landlock requested but failed functional test — falling back to mode=none');
    mode = 'none';
  } else if (requested === 'bwrap' && !testBwrap()) {
    console.warn('[sandbox] bwrap requested but failed functional test — falling back to mode=none');
    mode = 'none';
  }

  _config = {
    enabled: mode !== 'none',
    mode,
  };

  return _config;
}
