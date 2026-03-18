import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseOAuthExpiry, isTokenExpiredOrExpiring, refreshOAuthCredentials } from './credential-refresh.js';

const VALID_CREDS = {
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-old',
    refreshToken: 'sk-ant-ort01-old',
    expiresAt: Date.now() + 3600_000, // 1 hour from now
    scopes: ['user:inference'],
    subscriptionType: 'max',
    rateLimitTier: 'max_1',
  },
};

function makeCreds(overrides?: Partial<typeof VALID_CREDS.claudeAiOauth>): string {
  return JSON.stringify({
    claudeAiOauth: { ...VALID_CREDS.claudeAiOauth, ...overrides },
  });
}

describe('parseOAuthExpiry', () => {
  it('extracts expiresAt and hasRefreshToken from valid creds', () => {
    const result = parseOAuthExpiry(makeCreds());
    expect(result.hasRefreshToken).toBe(true);
    expect(result.expiresAt).toBeTypeOf('number');
    expect(result.expiresAt).toBeGreaterThan(Date.now());
  });

  it('handles string expiresAt', () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const result = parseOAuthExpiry(makeCreds({ expiresAt: future as unknown as number }));
    expect(result.expiresAt).toBeTypeOf('number');
    expect(result.hasRefreshToken).toBe(true);
  });

  it('returns hasRefreshToken=false when missing', () => {
    const creds = JSON.stringify({ claudeAiOauth: { accessToken: 'x' } });
    const result = parseOAuthExpiry(creds);
    expect(result.hasRefreshToken).toBe(false);
  });

  it('returns hasRefreshToken=false for empty string', () => {
    const result = parseOAuthExpiry(makeCreds({ refreshToken: '' }));
    expect(result.hasRefreshToken).toBe(false);
  });

  it('handles missing claudeAiOauth section', () => {
    const result = parseOAuthExpiry(JSON.stringify({ foo: 'bar' }));
    expect(result.hasRefreshToken).toBe(false);
    expect(result.expiresAt).toBeUndefined();
  });

  it('handles malformed JSON', () => {
    const result = parseOAuthExpiry('not json');
    expect(result.hasRefreshToken).toBe(false);
    expect(result.expiresAt).toBeUndefined();
  });

  it('handles missing expiresAt', () => {
    const creds = JSON.stringify({ claudeAiOauth: { refreshToken: 'rt' } });
    const result = parseOAuthExpiry(creds);
    expect(result.expiresAt).toBeUndefined();
    expect(result.hasRefreshToken).toBe(true);
  });
});

describe('isTokenExpiredOrExpiring', () => {
  it('returns false for a fresh token', () => {
    expect(isTokenExpiredOrExpiring(makeCreds({ expiresAt: Date.now() + 3600_000 }))).toBe(false);
  });

  it('returns true for an expired token', () => {
    expect(isTokenExpiredOrExpiring(makeCreds({ expiresAt: Date.now() - 1000 }))).toBe(true);
  });

  it('returns true within 5-min grace window', () => {
    expect(isTokenExpiredOrExpiring(makeCreds({ expiresAt: Date.now() + 2 * 60_000 }))).toBe(true);
  });

  it('returns false when expiresAt is missing (can\'t determine)', () => {
    const creds = JSON.stringify({ claudeAiOauth: { refreshToken: 'rt' } });
    expect(isTokenExpiredOrExpiring(creds)).toBe(false);
  });
});

describe('refreshOAuthCredentials', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubEnv('CLAUDE_CODE_OAUTH_CLIENT_ID', '');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it('returns error for invalid JSON', async () => {
    const result = await refreshOAuthCredentials('not json');
    expect(result.refreshed).toBe(false);
    expect(result.error).toContain('Invalid credentials JSON');
  });

  it('returns error when no claudeAiOauth section', async () => {
    const result = await refreshOAuthCredentials(JSON.stringify({ foo: 1 }));
    expect(result.refreshed).toBe(false);
    expect(result.error).toContain('No claudeAiOauth section');
  });

  it('returns error when no refresh token', async () => {
    const creds = JSON.stringify({ claudeAiOauth: { accessToken: 'x' } });
    const result = await refreshOAuthCredentials(creds);
    expect(result.refreshed).toBe(false);
    expect(result.error).toContain('No refresh token');
  });

  it('refreshes successfully and preserves existing fields', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        access_token: 'sk-ant-oat01-new',
        refresh_token: 'sk-ant-ort01-new',
        expires_in: 28800,
        token_type: 'bearer',
      }),
    });

    const result = await refreshOAuthCredentials(makeCreds());
    expect(result.refreshed).toBe(true);
    expect(result.credentialsJson).toBeDefined();
    expect(result.expiresAt).toBeTypeOf('number');
    expect(result.expiresAt!).toBeGreaterThan(Date.now());

    // Verify updated JSON preserves existing fields
    const updated = JSON.parse(result.credentialsJson!) as Record<string, unknown>;
    const oauth = updated['claudeAiOauth'] as Record<string, unknown>;
    expect(oauth['accessToken']).toBe('sk-ant-oat01-new');
    expect(oauth['refreshToken']).toBe('sk-ant-ort01-new');
    expect(oauth['scopes']).toEqual(['user:inference']);
    expect(oauth['subscriptionType']).toBe('max');
    expect(oauth['rateLimitTier']).toBe('max_1');

    // Verify the request was correct
    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(fetchCall[0]).toBe('https://platform.claude.com/v1/oauth/token');
    const reqInit = fetchCall[1] as RequestInit;
    expect(reqInit.method).toBe('POST');
    expect(reqInit.body).toContain('grant_type=refresh_token');
    expect(reqInit.body).toContain('refresh_token=sk-ant-ort01-old');
  });

  it('handles HTTP error response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: () => Promise.resolve('{"error":"invalid_grant"}'),
    });

    const result = await refreshOAuthCredentials(makeCreds());
    expect(result.refreshed).toBe(false);
    expect(result.error).toContain('400');
    expect(result.error).toContain('invalid_grant');
  });

  it('handles missing access_token in response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ token_type: 'bearer' }),
    });

    const result = await refreshOAuthCredentials(makeCreds());
    expect(result.refreshed).toBe(false);
    expect(result.error).toContain('missing access_token');
  });

  it('handles fetch timeout', async () => {
    globalThis.fetch = vi.fn().mockImplementation(() => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });

    const result = await refreshOAuthCredentials(makeCreds());
    expect(result.refreshed).toBe(false);
    expect(result.error).toContain('timed out');
  });

  it('handles network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await refreshOAuthCredentials(makeCreds());
    expect(result.refreshed).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('respects CLAUDE_CODE_OAUTH_CLIENT_ID env override', async () => {
    vi.stubEnv('CLAUDE_CODE_OAUTH_CLIENT_ID', 'custom-client-id');
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        access_token: 'new-token',
        expires_in: 28800,
      }),
    });

    await refreshOAuthCredentials(makeCreds());
    const body = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].body as string;
    expect(body).toContain('client_id=custom-client-id');
  });
});
