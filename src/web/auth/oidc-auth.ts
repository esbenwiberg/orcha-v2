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

const MAX_AUTH_RETRIES = 2;
const LOGIN_DEDUP_WINDOW_MS = 120_000; // 2 minutes

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

  // Derive the OIDC session key from the issuer hostname (used by openid-client internally)
  const issuerHost = new URL(discoveryUrl).hostname;

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

  // Fix 2: Login deduplication guard — prevent multiple OIDC state generations
  // when parallel requests (SSE, HTMX partials) all discover expired auth at once.
  router.get('/auth/login', (req, res, next) => {
    const force = req.query.force === '1';
    const session = req.session as Record<string, unknown> | null | undefined;

    if (!force && session) {
      // Check if we already have an in-flight OIDC login (code_verifier exists
      // and was stamped recently). The session key openid-client uses varies by
      // issuer hostname, so we look for any key containing code_verifier.
      const oidcState = session[issuerHost] as Record<string, unknown> | undefined;
      const hasVerifier = oidcState && typeof oidcState.code_verifier === 'string';
      const loginTs = typeof session._oidcLoginTs === 'number' ? session._oidcLoginTs : 0;
      const age = Date.now() - loginTs;

      if (hasVerifier && age < LOGIN_DEDUP_WINDOW_MS) {
        // Another request already started the OIDC flow — show a wait page
        // instead of overwriting the state/code_verifier.
        res.status(200).send(
          '<!doctype html><html><head><meta charset="utf-8">' +
            '<meta http-equiv="refresh" content="3;url=/">' +
            '<title>Signing in…</title>' +
            '<style>body{font-family:system-ui;display:flex;align-items:center;' +
            'justify-content:center;min-height:100vh;margin:0;background:#0f1117;color:#e4e4e7}' +
            '.box{text-align:center}a{color:#818cf8}</style></head>' +
            '<body><div class="box"><p>Signing in&hellip;</p>' +
            '<p style="font-size:0.85em;opacity:0.7">Redirecting in a few seconds.</p>' +
            '<p style="font-size:0.8em"><a href="/auth/login?force=1">Retry login</a></p>' +
            '</div></body></html>',
        );
        return;
      }
    }

    // Clear stale state if force=1
    if (force && session) {
      const oidcState = session[issuerHost];
      if (oidcState) {
        delete (session as Record<string, unknown>)[issuerHost];
      }
    }

    // Stamp the login timestamp before starting the OIDC flow
    if (session) {
      (session as Record<string, unknown>)._oidcLoginTs = Date.now();
    }

    passport.authenticate('oidc', { scope: ['openid', 'profile', 'email'] })(req, res, next);
  });

  // Fix 1: Callback error auto-recovery — on state mismatch, clear session
  // and redirect to /auth/login for a clean retry instead of showing a 500.
  router.get('/auth/callback', (req, res, next) => {
    passport.authenticate(
      'oidc',
      (err: Error | null, user: Express.User | false | null, info?: { message?: string }) => {
        if (err) {
          const errMsg = String((err as { message?: string }).message ?? '');
          const errCode = (err as { code?: string }).code;
          const isStateMismatch =
            errCode === 'OAUTH_INVALID_RESPONSE' ||
            errMsg.includes('state') ||
            errMsg.includes('code_verifier');

          if (isStateMismatch) {
            const retryCount = parseInt(String(req.query._authRetry), 10) || 0;
            if (retryCount < MAX_AUTH_RETRIES) {
              console.warn(
                `[auth] OIDC state mismatch (attempt ${retryCount + 1}/${MAX_AUTH_RETRIES}), clearing session and retrying:`,
                errMsg,
              );
              req.session = null;
              res.redirect(`/auth/login?force=1&_authRetry=${retryCount + 1}`);
              return;
            }
            console.error(
              `[auth] OIDC state mismatch after ${MAX_AUTH_RETRIES} retries, giving up:`,
              errMsg,
            );
          } else {
            console.error('[auth] OIDC callback error:', err);
          }
          next(err);
          return;
        }
        if (!user) {
          const reason =
            (info as { message?: string } | undefined)?.message ?? 'unknown reason';
          // Check if this is a state/verifier mismatch that came through as !user
          if (
            reason.includes('state') ||
            reason.includes('code_verifier') ||
            reason.includes('Unable to verify')
          ) {
            const retryCount = parseInt(String(req.query._authRetry), 10) || 0;
            if (retryCount < MAX_AUTH_RETRIES) {
              console.warn(
                `[auth] OIDC verification failed (attempt ${retryCount + 1}/${MAX_AUTH_RETRIES}), clearing session and retrying:`,
                reason,
              );
              req.session = null;
              res.redirect(`/auth/login?force=1&_authRetry=${retryCount + 1}`);
              return;
            }
          }
          console.error('[auth] OIDC authentication failed:', reason);
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

