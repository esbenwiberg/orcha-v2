import { describe, it, expect, vi, afterEach } from 'vitest';

// Mock node:fs/promises so we can control /proc/mounts content
vi.mock('node:fs/promises');

import fs from 'node:fs/promises';

const mockReadFile = vi.mocked(fs.readFile);

describe('checkVolumeMount', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // Reset the module so process.platform changes take effect
    vi.resetModules();
  });

  it('(a) returns { persistent: false, warning: null } on non-Linux platforms', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });

    const { checkVolumeMount } = await import('./volume-check.js');
    const result = await checkVolumeMount('/data');

    expect(result).toEqual({ persistent: false, warning: null });
  });

  it('(b) returns warning string on Linux when /data is not in /proc/mounts', async () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' });

    mockReadFile.mockResolvedValue(
      [
        'sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0',
        'proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0',
        'tmpfs /tmp tmpfs rw,nosuid,nodev 0 0',
        '',
      ].join('\n') as unknown as ArrayBuffer,
    );

    const { checkVolumeMount } = await import('./volume-check.js');
    const result = await checkVolumeMount('/data');

    expect(result.persistent).toBe(false);
    expect(result.warning).toBeTruthy();
    expect(result.warning).toContain('WARNING');
    expect(result.warning).toContain('/data');
  });
});
