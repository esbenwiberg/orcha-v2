export type SandboxMode = 'bwrap' | 'none';

export interface SandboxConfig {
  enabled: boolean;
  mode: SandboxMode;
}

let _config: SandboxConfig | undefined;

export function loadSandboxConfig(): SandboxConfig {
  if (_config !== undefined) return _config;

  const mode = (process.env['SANDBOX_MODE'] ?? 'none') as SandboxMode;
  _config = {
    enabled: mode !== 'none',
    mode,
  };

  return _config;
}
