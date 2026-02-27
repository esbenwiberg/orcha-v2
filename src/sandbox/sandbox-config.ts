export type SandboxMode = 'bwrap' | 'none';

export interface SandboxConfig {
  enabled: boolean;
  mode: SandboxMode;
  memoryMax: string;
  cpuQuota: string;
}

let _config: SandboxConfig | undefined;

export function loadSandboxConfig(): SandboxConfig {
  if (_config !== undefined) return _config;

  const mode = (process.env['SANDBOX_MODE'] ?? 'none') as SandboxMode;
  _config = {
    enabled: mode !== 'none',
    mode,
    memoryMax: process.env['SANDBOX_MEMORY_MAX'] ?? '512M',
    cpuQuota: process.env['SANDBOX_CPU_QUOTA'] ?? '100%',
  };

  return _config;
}
