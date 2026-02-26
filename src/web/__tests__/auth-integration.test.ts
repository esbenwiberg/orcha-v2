import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import WebSocket from 'ws';
import { createTestServer, buildMockActiveSession } from './helpers/test-server.js';
import type { TestServer } from './helpers/test-server.js';

// ---------------------------------------------------------------------------
// OIDC mock — declared at module level so Vitest can hoist it.
// Prevents real network discovery calls when the server starts in OIDC mode.
// The factory is synchronous to guarantee Vitest applies it before any import.
// ---------------------------------------------------------------------------

vi.mock('../auth/oidc-auth.js', () => {
  const noopMiddleware = (
    _req: unknown,
    _res: unknown,
    next: () => void,
  ) => next();

  const ensureAuthenticated = (
    req: { path: string; isAuthenticated?: () => boolean },
    res: {
      status: (code: number) => { json: (body: unknown) => void };
      redirect: (url: string) => void;
    },
    next: () => void,
  ) => {
    if (typeof req.isAuthenticated === 'function' && req.isAuthenticated()) {
      next();
      return;
    }
    if (req.path.startsWith('/api')) {
      res.status(401).json({ error: { code: 'AUTH_REQUIRED', message: 'Unauthorized' } });
      return;
    }
    res.redirect('/auth/login');
  };

  // Return undefined for the router so buildAuthMiddleware skips mounting it
  // (authRouter !== undefined check in app.ts), avoiding Express router type issues.
  const buildOidcAuth = vi.fn().mockResolvedValue({
    initialize: noopMiddleware,
    session: noopMiddleware,
    ensureAuthenticated,
    router: undefined,
  });

  return { buildOidcAuth };
});

// ---------------------------------------------------------------------------
// no-auth suite
// ---------------------------------------------------------------------------

describe('auth: none', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer({ mode: 'none' });
  });

  afterAll(async () => {
    await server.close();
  });

  it('GET /health without Authorization returns 200', async () => {
    const res = await request(server.url).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok' });
  });

  it('GET /api/sessions returns 200 with data array', async () => {
    const res = await request(server.url).get('/api/sessions');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// token auth suite
// ---------------------------------------------------------------------------

describe('auth: token', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer({ mode: 'token', token: 'test-secret-abc' });
  });

  afterAll(async () => {
    await server.close();
  });

  it('(b) GET /api/sessions with no Authorization returns 401 AUTH_REQUIRED', async () => {
    const res = await request(server.url).get('/api/sessions');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
  });

  it('(c) GET /api/sessions with wrong Bearer token returns 401', async () => {
    const res = await request(server.url)
      .get('/api/sessions')
      .set('Authorization', 'Bearer wrong-token');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
  });

  it('(d) GET /api/sessions with correct Bearer token returns 200', async () => {
    const res = await request(server.url)
      .get('/api/sessions')
      .set('Authorization', 'Bearer test-secret-abc');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('data');
  });

  it('(e) partial token (correct prefix, extra suffix) returns 401', async () => {
    const res = await request(server.url)
      .get('/api/sessions')
      .set('Authorization', 'Bearer test-secret-abc-extra');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// oidc suite — relies on the module-level vi.mock above
// ---------------------------------------------------------------------------

describe('auth: oidc (mocked discovery)', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer({
      mode: 'oidc',
      oidcClientId: 'mock-client-id',
      oidcClientSecret: 'mock-client-secret',
      oidcDiscoveryUrl: 'https://mock.example.com/.well-known/openid-configuration',
      oidcRedirectUri: 'http://localhost:0/auth/callback',
      sessionSecret: 'oidc-test-secret',
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it('(b) GET /api/sessions without auth returns 401', async () => {
    const res = await request(server.url).get('/api/sessions');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
  });

  it('(c) GET / without auth returns 302 redirect to /auth/login', async () => {
    const res = await request(server.url).get('/').redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('/auth/login');
  });
});

// ---------------------------------------------------------------------------
// WebSocket auth tests
// ---------------------------------------------------------------------------

describe('WebSocket auth', () => {
  let server: TestServer;
  const SESSION_ID = 'ws-test-session';

  beforeAll(async () => {
    const mockSession = buildMockActiveSession(SESSION_ID);

    server = await createTestServer(
      { mode: 'token', token: 'ws-secret' },
      {
        getSession: vi.fn().mockReturnValue(mockSession),
      },
    );
  });

  afterAll(async () => {
    await server.close();
  });

  it('(a) WebSocket connection without Authorization header is rejected', async () => {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${server.wsUrl}/ws/terminal/${SESSION_ID}`);

      const timeout = setTimeout(() => {
        ws.removeAllListeners();
        reject(new Error('WebSocket did not receive rejection within timeout'));
      }, 5000);

      const finish = (): void => {
        clearTimeout(timeout);
        ws.removeAllListeners();
        resolve();
      };

      // The server writes HTTP/1.1 401 and destroys the socket before completing
      // the handshake. The ws client emits 'unexpected-response' or 'error'.
      ws.on('unexpected-response', (_req, res) => {
        expect(res.statusCode).toBe(401);
        finish();
      });

      ws.on('error', () => {
        // Any network error from a rejected handshake is acceptable.
        finish();
      });

      ws.on('close', () => {
        finish();
      });
    });
  });

  it('(b) WebSocket connection with correct Authorization header opens successfully', async () => {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`${server.wsUrl}/ws/terminal/${SESSION_ID}`, {
        headers: { Authorization: 'Bearer ws-secret' },
      });

      const timeout = setTimeout(() => {
        ws.removeAllListeners();
        reject(new Error('WebSocket did not open within timeout'));
      }, 5000);

      ws.on('open', () => {
        clearTimeout(timeout);
        expect(ws.readyState).toBe(WebSocket.OPEN);
        ws.close();
        resolve();
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  });
});
