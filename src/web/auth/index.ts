import session from 'express-session';
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

      const sessionMiddleware = session({
        secret: config.sessionSecret,
        resave: false,
        saveUninitialized: false,
        cookie: { httpOnly: true, sameSite: 'lax' },
      }) as express.RequestHandler;

      return {
        middleware: [
          sessionMiddleware,
          oidcHandlers.initialize,
          oidcHandlers.session,
          oidcHandlers.ensureAuthenticated,
        ],
        router: oidcHandlers.router,
      };
    }
  }
}
