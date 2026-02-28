import cookieSession from 'cookie-session';
import type express from 'express';
import type { AuthConfig } from './types.js';
import { noAuthMiddleware } from './no-auth.js';
import { tokenAuthMiddleware } from './token-auth.js';
import { buildOidcAuth } from './oidc-auth.js';

export type { AuthConfig, AuthMode, AuthenticatedUser } from './types.js';
export { loadAuthConfig } from './types.js';

export interface AuthResult {
  middleware: express.RequestHandler[];
  router: express.Router | undefined;
}

/**
 * Passport v0.6+ calls req.session.regenerate() and req.session.save() which
 * are express-session methods. cookie-session doesn't provide them, so we add
 * no-op shims immediately after the cookie-session middleware.
 */
const passportSessionCompat: express.RequestHandler = (req, _res, next) => {
  if (req.session != null) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = req.session as any;
    if (s.regenerate === undefined) {
      s.regenerate = (cb: () => void) => {
        cb();
      };
    }
    if (s.save === undefined) {
      s.save = (cb: () => void) => {
        cb();
      };
    }
  }
  next();
};

export async function buildAuthMiddleware(config: AuthConfig): Promise<AuthResult> {
  switch (config.mode) {
    case 'none':
      return { middleware: [noAuthMiddleware()], router: undefined };

    case 'token': {
      if (config.token === undefined) {
        throw new Error('[auth] Token mode requires AUTH_TOKEN to be set');
      }
      return { middleware: [tokenAuthMiddleware(config.token)], router: undefined };
    }

    case 'oidc': {
      if (
        config.oidcClientId === undefined ||
        config.oidcClientSecret === undefined ||
        config.oidcDiscoveryUrl === undefined
      ) {
        throw new Error(
          '[auth] OIDC mode requires OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, and OIDC_DISCOVERY_URL to be set',
        );
      }

      const oidcHandlers = await buildOidcAuth(config);

      // Cookie-session stores all session data (OIDC state during login + authenticated
      // user after login) in a signed cookie. This is fully stateless — no server-side
      // store needed. Survives container restarts, scale-to-zero, and multi-replica ACA
      // deployments without any session affinity requirement.
      const sessionMiddleware = cookieSession({
        name: 'orcha.sid',
        keys: [config.sessionSecret],
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env['NODE_ENV'] === 'production',
      }) as unknown as express.RequestHandler;

      return {
        middleware: [
          sessionMiddleware,
          passportSessionCompat,
          oidcHandlers.initialize,
          oidcHandlers.session,
          oidcHandlers.ensureAuthenticated,
        ],
        router: oidcHandlers.router,
      };
    }
  }
}
