import { Router } from 'express';
import type express from 'express';
import passport from 'passport';
import { discovery, ClientSecretPost } from 'openid-client';
import { Strategy } from 'openid-client/passport';
import type { AuthConfig } from './types.js';

export interface OidcAuthHandlers {
  initialize: express.RequestHandler;
  session: express.RequestHandler;
  ensureAuthenticated: express.RequestHandler;
  router: express.Router;
}

export async function buildOidcAuth(config: AuthConfig): Promise<OidcAuthHandlers> {
  const discoveryUrl = config.oidcDiscoveryUrl!;
  const clientId = config.oidcClientId!;
  const clientSecret = config.oidcClientSecret!;
  const redirectUri = config.oidcRedirectUri ?? 'http://localhost:3000/auth/callback';

  // Discover the provider metadata using openid-client v6 API
  const oidcConfig = await discovery(
    new URL(discoveryUrl),
    clientId,
    undefined,
    ClientSecretPost(clientSecret),
  );

  // Register passport strategy using openid-client/passport
  passport.use(
    'oidc',
    new Strategy(
      {
        config: oidcConfig,
        callbackURL: redirectUri,
      },
      (tokens, verified) => {
        // Extract user info from the ID token claims
        const claims = tokens.claims();
        const sub = claims?.sub ?? 'unknown';
        const name = typeof claims?.name === 'string' ? claims.name : undefined;
        const email = typeof claims?.email === 'string' ? claims.email : undefined;
        verified(null, { id: sub, name, email });
      },
    ),
  );

  // Serialize/deserialize user for session storage
  passport.serializeUser((user, done) => {
    done(null, user);
  });

  passport.deserializeUser((user, done) => {
    done(null, user as Express.User);
  });

  // ensureAuthenticated guards protected routes
  const ensureAuthenticated: express.RequestHandler = (req, res, next) => {
    if (req.isAuthenticated()) {
      next();
      return;
    }
    if (req.path.startsWith('/api')) {
      res.status(401).json({ error: { code: 'AUTH_REQUIRED', message: 'Unauthorized' } });
      return;
    }
    res.redirect('/auth/login');
  };

  // Auth router: login, callback, logout
  const router = Router();

  router.get('/auth/login', passport.authenticate('oidc', { scope: ['openid', 'profile', 'email'] }));

  router.get('/auth/callback', (req, res, next) => {
    passport.authenticate(
      'oidc',
      (err: Error | null, user: Express.User | false | null, info?: { message?: string }) => {
        if (err) {
          console.error('[auth] OIDC callback error:', err);
          next(err);
          return;
        }
        if (!user) {
          console.error(
            '[auth] OIDC authentication failed:',
            (info as { message?: string } | undefined)?.message ?? 'unknown reason',
          );
          res.redirect('/auth/login');
          return;
        }
        req.logIn(user, (loginErr) => {
          if (loginErr) {
            console.error('[auth] Session login error:', loginErr);
            next(loginErr);
            return;
          }
          res.redirect('/');
        });
      },
    )(req, res, next);
  });

  router.get('/auth/logout', (req, res, next) => {
    req.logout((err) => {
      if (err !== null && err !== undefined) {
        next(err);
        return;
      }
      res.redirect('/');
    });
  });

  return {
    initialize: passport.initialize() as express.RequestHandler,
    session: passport.session() as express.RequestHandler,
    ensureAuthenticated,
    router,
  };
}

