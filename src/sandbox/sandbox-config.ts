import { execSync } from 'node:child_process';

export type SandboxMode = 'bwrap' | 'none';

export interface SandboxConfig {
  enabled: boolean;
  mode: SandboxMode;
}

let _config: SandboxConfig | undefined;

/**
 * Tests whether bwrap actually works by running a minimal sandbox.
 * Returns false if bwrap is unavailable or user namespaces are restricted.
 */
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
  if (requested === 'bwrap' && !testBwrap()) {
    console.warn('[sandbox] bwrap requested but failed functional test — falling back to mode=none');
    mode = 'none';
  }

  _config = {
    enabled: mode !== 'none',
    mode,
  };

  return _config;
}
