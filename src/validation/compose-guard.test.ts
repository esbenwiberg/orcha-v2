import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { auditComposeFile, checkRemoteDockerWarnings, enforceComposeGuard } from './compose-guard.js';

describe('auditComposeFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'compose-guard-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes a clean compose file', () => {
    const path = join(dir, 'docker-compose.yml');
    writeFileSync(path, `
services:
  app:
    build: .
    ports:
      - "3000:3000"
`);
    expect(auditComposeFile(path)).toEqual([]);
  });

  it('catches privileged mode', () => {
    const path = join(dir, 'docker-compose.yml');
    writeFileSync(path, `
services:
  app:
    image: node
    privileged: true
`);
    const violations = auditComposeFile(path);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.issue).toContain('privileged');
  });

  it('catches docker.sock volume mount', () => {
    const path = join(dir, 'docker-compose.yml');
    writeFileSync(path, `
services:
  app:
    image: node
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
`);
    const violations = auditComposeFile(path);
    // Matches both /var/run/docker.sock and /var/run/docker from DANGEROUS_VOLUMES
    expect(violations.length).toBeGreaterThanOrEqual(1);
    expect(violations.some((v) => v.issue.includes('docker.sock'))).toBe(true);
  });
});

describe('checkRemoteDockerWarnings', () => {
  let dir: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'compose-guard-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, savedEnv);
  });

  it('returns no warnings when not using remote Docker', () => {
    delete process.env['DOCKER_HOST'];
    const path = join(dir, 'docker-compose.yml');
    writeFileSync(path, `
services:
  app:
    build: .
    volumes:
      - ./src:/app/src
`);
    expect(checkRemoteDockerWarnings(path)).toEqual([]);
  });

  it('warns about relative bind mounts with remote Docker', () => {
    process.env['DOCKER_HOST'] = 'tcp://10.0.1.4:2376';
    const path = join(dir, 'docker-compose.yml');
    writeFileSync(path, `
services:
  app:
    build: .
    volumes:
      - ./src:/app/src
      - ../shared:/app/shared
`);
    const warnings = checkRemoteDockerWarnings(path);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('./src');
    expect(warnings[0]).toContain("won't work with remote Docker");
    expect(warnings[1]).toContain('../shared');
  });

  it('warns about absolute host path bind mounts with remote Docker', () => {
    process.env['DOCKER_HOST'] = 'tcp://10.0.1.4:2376';
    const path = join(dir, 'docker-compose.yml');
    writeFileSync(path, `
services:
  app:
    build: .
    volumes:
      - /home/user/data:/app/data
`);
    const warnings = checkRemoteDockerWarnings(path);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('/home/user/data');
  });

  it('does not warn about named volumes', () => {
    process.env['DOCKER_HOST'] = 'tcp://10.0.1.4:2376';
    const path = join(dir, 'docker-compose.yml');
    writeFileSync(path, `
services:
  db:
    image: postgres
    volumes:
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata:
`);
    const warnings = checkRemoteDockerWarnings(path);
    expect(warnings).toEqual([]);
  });

  it('skips dangerous volumes (those are handled by auditComposeFile)', () => {
    process.env['DOCKER_HOST'] = 'tcp://10.0.1.4:2376';
    const path = join(dir, 'docker-compose.yml');
    writeFileSync(path, `
services:
  app:
    build: .
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
`);
    // checkRemoteDockerWarnings should not warn about these —
    // auditComposeFile already blocks them
    const warnings = checkRemoteDockerWarnings(path);
    expect(warnings).toEqual([]);
  });
});

describe('enforceComposeGuard', () => {
  let dir: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'compose-guard-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, savedEnv);
  });

  it('throws on security violations', () => {
    const path = join(dir, 'docker-compose.yml');
    writeFileSync(path, `
services:
  app:
    image: node
    privileged: true
`);
    expect(() => enforceComposeGuard(path)).toThrow('security violations');
  });

  it('returns remote Docker warnings for clean file', () => {
    process.env['DOCKER_HOST'] = 'tcp://10.0.1.4:2376';
    const path = join(dir, 'docker-compose.yml');
    writeFileSync(path, `
services:
  app:
    build: .
    volumes:
      - ./src:/app/src
`);
    const warnings = enforceComposeGuard(path);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('./src');
  });

  it('returns empty array for clean file without remote Docker', () => {
    delete process.env['DOCKER_HOST'];
    const path = join(dir, 'docker-compose.yml');
    writeFileSync(path, `
services:
  app:
    build: .
`);
    expect(enforceComposeGuard(path)).toEqual([]);
  });
});
