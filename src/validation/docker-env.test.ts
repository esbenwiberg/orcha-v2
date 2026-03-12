import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isRemoteDocker, canJoinDockerNetwork, getDockerVmIp } from './docker-env.js';

describe('isRemoteDocker', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, savedEnv);
  });

  it('returns true when DOCKER_HOST is tcp://', () => {
    process.env['DOCKER_HOST'] = 'tcp://10.0.1.4:2376';
    expect(isRemoteDocker()).toBe(true);
  });

  it('returns false when DOCKER_HOST is unset', () => {
    delete process.env['DOCKER_HOST'];
    expect(isRemoteDocker()).toBe(false);
  });

  it('returns false when DOCKER_HOST is a unix socket', () => {
    process.env['DOCKER_HOST'] = 'unix:///var/run/docker.sock';
    expect(isRemoteDocker()).toBe(false);
  });

  it('returns false when DOCKER_HOST is empty', () => {
    process.env['DOCKER_HOST'] = '';
    expect(isRemoteDocker()).toBe(false);
  });
});

describe('canJoinDockerNetwork', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, savedEnv);
  });

  it('returns false when DOCKER_HOST points to remote', () => {
    // Even if we're somehow "inside Docker", remote means no network joining
    process.env['DOCKER_HOST'] = 'tcp://10.0.1.4:2376';
    expect(canJoinDockerNetwork()).toBe(false);
  });

  it('returns false on local dev (no /.dockerenv)', () => {
    // In test env we're not inside Docker, so this should be false
    delete process.env['DOCKER_HOST'];
    expect(canJoinDockerNetwork()).toBe(false);
  });
});

describe('getDockerVmIp', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, savedEnv);
  });

  it('parses IP from DOCKER_HOST tcp URL', () => {
    delete process.env['DOCKER_VM_IP'];
    process.env['DOCKER_HOST'] = 'tcp://10.0.1.4:2376';
    expect(getDockerVmIp()).toBe('10.0.1.4');
  });

  it('prefers explicit DOCKER_VM_IP over DOCKER_HOST', () => {
    process.env['DOCKER_VM_IP'] = '192.168.1.100';
    process.env['DOCKER_HOST'] = 'tcp://10.0.1.4:2376';
    expect(getDockerVmIp()).toBe('192.168.1.100');
  });

  it('returns null when neither env var is set', () => {
    delete process.env['DOCKER_VM_IP'];
    delete process.env['DOCKER_HOST'];
    expect(getDockerVmIp()).toBeNull();
  });

  it('handles DOCKER_HOST without port', () => {
    delete process.env['DOCKER_VM_IP'];
    process.env['DOCKER_HOST'] = 'tcp://10.0.1.4';
    expect(getDockerVmIp()).toBe('10.0.1.4');
  });

  it('returns null for unparseable DOCKER_HOST', () => {
    delete process.env['DOCKER_VM_IP'];
    process.env['DOCKER_HOST'] = 'not-a-url';
    expect(getDockerVmIp()).toBeNull();
  });
});
