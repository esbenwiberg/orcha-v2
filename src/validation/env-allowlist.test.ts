import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sanitizeEnvForValidation, sanitizeEnvForDocker } from './env-allowlist.js';

describe('sanitizeEnvForValidation', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    // Simulate Orcha's production env with secrets
    process.env['PATH'] = '/usr/bin:/usr/local/bin';
    process.env['HOME'] = '/home/orcha';
    process.env['NODE_ENV'] = 'production';
    process.env['LANG'] = 'en_US.UTF-8';
    process.env['USER'] = 'orcha';

    // Secrets that must NOT leak
    process.env['AUTH_TOKEN'] = 'super-secret-auth-token';
    process.env['SESSION_SECRET'] = 'super-secret-session';
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-secret';
    process.env['ANTHROPIC_AUTH_TOKEN'] = 'ant-auth-secret';
    process.env['GH_TOKEN'] = 'ghp_secret123';
    process.env['GITHUB_TOKEN'] = 'ghp_secret456';
    process.env['DEVOPS_BOOTSTRAP_PAT'] = 'devops-pat-secret';
    process.env['AZURE_CLIENT_SECRET'] = 'azure-sp-secret';
    process.env['AZURE_CLIENT_ID'] = 'azure-client-id';
    process.env['AZURE_TENANT_ID'] = 'azure-tenant-id';
    process.env['AZURE_DEVOPS_EXT_PAT'] = 'devops-ext-pat';
    process.env['DOCKER_HOST'] = 'tcp://10.0.1.4:2376';
    process.env['DOCKER_TLS_VERIFY'] = '1';
    process.env['DOCKER_CERT_PATH'] = '/data/docker-tls';
  });

  afterEach(() => {
    // Restore original env
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, savedEnv);
  });

  it('passes through allowlisted system vars', () => {
    const env = sanitizeEnvForValidation();
    expect(env['PATH']).toBe('/usr/bin:/usr/local/bin');
    expect(env['HOME']).toBe('/home/orcha');
    expect(env['NODE_ENV']).toBe('production');
    expect(env['LANG']).toBe('en_US.UTF-8');
    expect(env['USER']).toBe('orcha');
  });

  it('blocks all known secrets', () => {
    const env = sanitizeEnvForValidation();
    expect(env['AUTH_TOKEN']).toBeUndefined();
    expect(env['SESSION_SECRET']).toBeUndefined();
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['ANTHROPIC_AUTH_TOKEN']).toBeUndefined();
    expect(env['GH_TOKEN']).toBeUndefined();
    expect(env['GITHUB_TOKEN']).toBeUndefined();
    expect(env['DEVOPS_BOOTSTRAP_PAT']).toBeUndefined();
    expect(env['AZURE_CLIENT_SECRET']).toBeUndefined();
    expect(env['AZURE_CLIENT_ID']).toBeUndefined();
    expect(env['AZURE_TENANT_ID']).toBeUndefined();
    expect(env['AZURE_DEVOPS_EXT_PAT']).toBeUndefined();
  });

  it('blocks Docker connection vars from non-docker contexts', () => {
    const env = sanitizeEnvForValidation();
    expect(env['DOCKER_HOST']).toBeUndefined();
    expect(env['DOCKER_TLS_VERIFY']).toBeUndefined();
    expect(env['DOCKER_CERT_PATH']).toBeUndefined();
  });

  it('merges extra vars', () => {
    const env = sanitizeEnvForValidation({ PORT: '3001', CUSTOM: 'value' });
    expect(env['PORT']).toBe('3001');
    expect(env['CUSTOM']).toBe('value');
    // System vars still present
    expect(env['PATH']).toBe('/usr/bin:/usr/local/bin');
  });

  it('extra vars override allowlisted vars', () => {
    const env = sanitizeEnvForValidation({ NODE_ENV: 'test' });
    expect(env['NODE_ENV']).toBe('test');
  });

  it('does not include unknown env vars', () => {
    process.env['RANDOM_UNKNOWN_VAR'] = 'should-not-leak';
    const env = sanitizeEnvForValidation();
    expect(env['RANDOM_UNKNOWN_VAR']).toBeUndefined();
  });

  it('passes through dotnet system vars', () => {
    process.env['DOTNET_CLI_HOME'] = '/tmp/dotnet-cli';
    process.env['DOTNET_SKIP_FIRST_TIME_EXPERIENCE'] = '1';
    process.env['DOTNET_NOLOGO'] = 'true';
    process.env['DOTNET_CLI_TELEMETRY_OPTOUT'] = '1';
    process.env['DOTNET_EnableDiagnostics'] = '0';
    process.env['DOTNET_GCHeapHardLimit'] = '0x20000000';
    process.env['DOTNET_CLI_DO_NOT_USE_MSBUILD_SERVER'] = '1';
    process.env['NUGET_PACKAGES'] = '/tmp/nuget-cache';

    const env = sanitizeEnvForValidation();
    expect(env['DOTNET_CLI_HOME']).toBe('/tmp/dotnet-cli');
    expect(env['DOTNET_SKIP_FIRST_TIME_EXPERIENCE']).toBe('1');
    expect(env['DOTNET_NOLOGO']).toBe('true');
    expect(env['DOTNET_CLI_TELEMETRY_OPTOUT']).toBe('1');
    expect(env['DOTNET_EnableDiagnostics']).toBe('0');
    expect(env['DOTNET_GCHeapHardLimit']).toBe('0x20000000');
    expect(env['DOTNET_CLI_DO_NOT_USE_MSBUILD_SERVER']).toBe('1');
    expect(env['NUGET_PACKAGES']).toBe('/tmp/nuget-cache');
  });

  it('extra env overrides dotnet allowlist vars (session HOME wins over host HOME)', () => {
    process.env['HOME'] = '/app';
    process.env['DOTNET_CLI_HOME'] = '/tmp/dotnet-cli';

    const env = sanitizeEnvForValidation({
      HOME: '/tmp/orcha-home-abc123',
      DOTNET_CLI_HOME: '/tmp/orcha-home-abc123',
      VSS_NUGET_EXTERNAL_FEED_ENDPOINTS: '{"endpointCredentials":[]}',
    });

    expect(env['HOME']).toBe('/tmp/orcha-home-abc123');
    expect(env['DOTNET_CLI_HOME']).toBe('/tmp/orcha-home-abc123');
    expect(env['VSS_NUGET_EXTERNAL_FEED_ENDPOINTS']).toBe('{"endpointCredentials":[]}');
  });
});

describe('sanitizeEnvForDocker', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    process.env['PATH'] = '/usr/bin';
    process.env['DOCKER_HOST'] = 'tcp://10.0.1.4:2376';
    process.env['DOCKER_TLS_VERIFY'] = '1';
    process.env['DOCKER_CERT_PATH'] = '/data/docker-tls';
    process.env['AUTH_TOKEN'] = 'secret';
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-secret';
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, savedEnv);
  });

  it('includes Docker connection vars', () => {
    const env = sanitizeEnvForDocker();
    expect(env['DOCKER_HOST']).toBe('tcp://10.0.1.4:2376');
    expect(env['DOCKER_TLS_VERIFY']).toBe('1');
    expect(env['DOCKER_CERT_PATH']).toBe('/data/docker-tls');
  });

  it('still blocks secrets', () => {
    const env = sanitizeEnvForDocker();
    expect(env['AUTH_TOKEN']).toBeUndefined();
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
  });

  it('includes system vars', () => {
    const env = sanitizeEnvForDocker();
    expect(env['PATH']).toBe('/usr/bin');
  });

  it('merges extra vars', () => {
    const env = sanitizeEnvForDocker({ PORT: '4000' });
    expect(env['PORT']).toBe('4000');
    expect(env['DOCKER_HOST']).toBe('tcp://10.0.1.4:2376');
  });
});
