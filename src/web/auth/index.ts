import session from 'express-session';
import type express from 'express';
import type Database from 'better-sqlite3';
import type { AuthConfig } from './types.js';
import { noAuthMiddleware } from './no-auth.js';
import { tokenAuthMiddleware } from './token-auth.js';
import { buildOidcAuth } from './oidc-auth.js';
import { SqliteSessionStore } from './session-store.js';

export type { AuthConfig, AuthMode, AuthenticatedUser } from './types.js';
export { loadAuthConfig } from './types.js';

export interface AuthResult {
  middleware: express.RequestHandler[];
  router: express.Router | undefined;
}

export async function buildAuthMiddleware(
  config: AuthConfig,
  db: Database.Database,
): Promise<AuthResult> {
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
      const store = new SqliteSessionStore(db);

      const sessionMiddleware = session({
        store,
        name: 'orcha.sid',
        secret: config.sessionSecret,
        resave: false,
        saveUninitialized: false,
        cookie: {
          httpOnly: true,
          sameSite: 'lax',
          secure: process.env['NODE_ENV'] === 'production',
          maxAge: 24 * 60 * 60 * 1000, // 24 hours
        },
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
