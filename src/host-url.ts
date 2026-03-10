/**
 * Resolve the external Orcha host URL.
 *
 * Priority:
 * 1. ORCHA_HOST env var (explicit override)
 * 2. Derived from OIDC_REDIRECT_URI origin (deployed instances already set this)
 * 3. http://localhost:${PORT}
 *
 * Returns the URL without a trailing slash, e.g. "https://orcha.example.com".
 */
export function resolveOrchaHost(): string {
  const explicit = process.env['ORCHA_HOST'];
  if (explicit) return explicit.replace(/\/+$/, '');

  const oidcRedirect = process.env['OIDC_REDIRECT_URI'];
  if (oidcRedirect) {
    try {
      const url = new URL(oidcRedirect);
      return url.origin;
    } catch {
      // Malformed URI — fall through
    }
  }

  const port = process.env['PORT'] ?? '3000';
  return `http://localhost:${port}`;
}
