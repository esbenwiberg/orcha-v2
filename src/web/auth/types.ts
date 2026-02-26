import crypto from 'node:crypto';

// AuthenticatedUser is our application-level user type.
// It does NOT extend Express.User to avoid circular type references.
export interface AuthenticatedUser {
  id: string;
  name: string | undefined;
  email: string | undefined;
}

// Module augmentation: make Express.User (used by passport's req.user) match
// our AuthenticatedUser shape. This lets route handlers access req.user with
// full typing without a circular inheritance chain.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface User {
      id: string;
      name: string | undefined;
      email: string | undefined;
    }
  }
}

export type AuthMode = 'none' | 'token' | 'oidc';

export interface AuthConfig {
  mode: AuthMode;
  token: string | undefined;
  oidcClientId: string | undefined;
  oidcClientSecret: string | undefined;
  oidcDiscoveryUrl: string | undefined;
  oidcRedirectUri: string | undefined;
  sessionSecret: string;
}

export function loadAuthConfig(): AuthConfig {
  const mode = (process.env['AUTH_MODE'] ?? 'none') as AuthMode;

  let sessionSecret = process.env['SESSION_SECRET'];
  if (sessionSecret === undefined) {
    if (mode !== 'none') {
      console.warn(
        '[auth] SESSION_SECRET is not set; using a random secret. All sessions will be invalidated on restart.',
      );
    }
    sessionSecret = crypto.randomBytes(32).toString('hex');
  }

  return {
    mode,
    token: process.env['AUTH_TOKEN'],
    oidcClientId: process.env['OIDC_CLIENT_ID'],
    oidcClientSecret: process.env['OIDC_CLIENT_SECRET'],
    oidcDiscoveryUrl: process.env['OIDC_DISCOVERY_URL'],
    oidcRedirectUri: process.env['OIDC_REDIRECT_URI'],
    sessionSecret,
  };
}
