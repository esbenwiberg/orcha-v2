import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../storage/volume-check.js', () => ({
  checkVolumeMount: vi.fn().mockResolvedValue({ persistent: true, warning: null }),
}));

describe('emitStartupDiagnostics', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs a single structured JSON line with the required fields', async () => {
    const { emitStartupDiagnostics } = await import('./startup.js');
    await emitStartupDiagnostics();

    expect(logSpy).toHaveBeenCalledOnce();

    const [rawArg] = logSpy.mock.calls[0] as [string];
    const parsed = JSON.parse(rawArg) as Record<string, unknown>;

    expect(parsed).toHaveProperty('event');
    expect(parsed).toHaveProperty('auth_mode');
    expect(parsed).toHaveProperty('db_path');
    expect(parsed).toHaveProperty('git_version');
    expect(parsed).toHaveProperty('node_pty_version');
    expect(parsed).toHaveProperty('node_version');
    expect(parsed).toHaveProperty('data_persistent');
    expect(parsed).toHaveProperty('data_warning');

    expect(parsed['event']).toBe('startup_diagnostics');
  });

  it('does not call console.warn when data_warning is null', async () => {
    const { emitStartupDiagnostics } = await import('./startup.js');
    await emitStartupDiagnostics();

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('calls console.warn when data_warning is non-null', async () => {
    const { checkVolumeMount } = await import('../storage/volume-check.js');
    vi.mocked(checkVolumeMount).mockResolvedValueOnce({
      persistent: false,
      warning: 'WARNING: /data is not a persistent mount',
    });

    const { emitStartupDiagnostics } = await import('./startup.js');
    await emitStartupDiagnostics();

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith('WARNING: /data is not a persistent mount');
  });
});
