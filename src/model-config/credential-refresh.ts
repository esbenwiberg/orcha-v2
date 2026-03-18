/**
 * Central OAuth token refresh for Max/Pro model configs.
 *
 * Instead of relying on Claude CLI to refresh tokens at session runtime,
 * Orcha refreshes them before session/task start using the same OAuth
 * endpoint the CLI uses. This avoids refresh-token rotation races that
 * cause 401s after container restarts or concurrent sessions.
 */

const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const DEFAULT_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const FETCH_TIMEOUT_MS = 15_000;
/** Refresh if access token expires within this window. */
const GRACE_WINDOW_MS = 5 * 60 * 1000;

export interface RefreshResult {
  refreshed: boolean;
  credentialsJson?: string;
  expiresAt?: number;
  error?: string;
}

export interface OAuthExpiryInfo {
  expiresAt?: number;
  hasRefreshToken: boolean;
}

/**
 * Parse OAuth expiry and refresh token presence from credentials JSON.
 * The credentials structure is: `{ claudeAiOauth: { expiresAt, refreshToken, ... } }`.
 */
export function parseOAuthExpiry(credentialsJson: string): OAuthExpiryInfo {
  try {
    const parsed = JSON.parse(credentialsJson) as Record<string, unknown>;
    const oauth = parsed['claudeAiOauth'] as Record<string, unknown> | undefined;
    if (!oauth) return { hasRefreshToken: false };

    const rawExpiry = oauth['expiresAt'];
    let expiresAt: number | undefined;
    if (typeof rawExpiry === 'number') {
      expiresAt = rawExpiry;
    } else if (typeof rawExpiry === 'string') {
      const ms = new Date(rawExpiry).getTime();
      if (!Number.isNaN(ms)) expiresAt = ms;
    }

    const hasRefreshToken = typeof oauth['refreshToken'] === 'string' && oauth['refreshToken'].length > 0;
    return {
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      hasRefreshToken,
    };
  } catch {
    return { hasRefreshToken: false };
  }
}

/**
 * Check whether the access token is expired or about to expire.
 */
export function isTokenExpiredOrExpiring(credentialsJson: string): boolean {
  const { expiresAt } = parseOAuthExpiry(credentialsJson);
  if (expiresAt === undefined) return false; // Can't tell — assume fresh
  return expiresAt < Date.now() + GRACE_WINDOW_MS;
}

/**
 * Refresh OAuth credentials by calling Anthropic's token endpoint.
 *
 * On success, returns updated credentials JSON preserving existing fields
 * (scopes, subscriptionType, rateLimitTier) and updating access/refresh
 * tokens + expiry.
 */
export async function refreshOAuthCredentials(credentialsJson: string): Promise<RefreshResult> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(credentialsJson) as Record<string, unknown>;
  } catch {
    return { refreshed: false, error: 'Invalid credentials JSON' };
  }

  const oauth = parsed['claudeAiOauth'] as Record<string, unknown> | undefined;
  if (!oauth) {
    return { refreshed: false, error: 'No claudeAiOauth section in credentials' };
  }

  const refreshToken = oauth['refreshToken'] as string | undefined;
  if (!refreshToken) {
    return { refreshed: false, error: 'No refresh token available' };
  }

  const clientId = process.env['CLAUDE_CODE_OAUTH_CLIENT_ID'] ?? DEFAULT_CLIENT_ID;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return {
        refreshed: false,
        error: `Token refresh failed: ${response.status} ${response.statusText}${text ? ` — ${text.slice(0, 200)}` : ''}`,
      };
    }

    const data = (await response.json()) as Record<string, unknown>;
    const newAccessToken = data['access_token'] as string | undefined;
    const newRefreshToken = data['refresh_token'] as string | undefined;
    const expiresIn = data['expires_in'] as number | undefined;

    if (!newAccessToken) {
      return { refreshed: false, error: 'Token response missing access_token' };
    }

    // Build updated credentials, preserving existing fields
    const newExpiresAt = expiresIn ? Date.now() + expiresIn * 1000 : undefined;
    const updatedOauth: Record<string, unknown> = {
      ...oauth,
      accessToken: newAccessToken,
      ...(newRefreshToken ? { refreshToken: newRefreshToken } : {}),
      ...(newExpiresAt !== undefined ? { expiresAt: newExpiresAt } : {}),
    };

    const updatedParsed: Record<string, unknown> = {
      ...parsed,
      claudeAiOauth: updatedOauth,
    };

    const updatedJson = JSON.stringify(updatedParsed);
    return {
      refreshed: true,
      credentialsJson: updatedJson,
      ...(newExpiresAt !== undefined ? { expiresAt: newExpiresAt } : {}),
    };
  } catch (err) {
    const msg = err instanceof Error && err.name === 'AbortError'
      ? 'Token refresh timed out'
      : `Token refresh error: ${String(err)}`;
    return { refreshed: false, error: msg };
  }
}
