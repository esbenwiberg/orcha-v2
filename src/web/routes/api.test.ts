import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Application } from 'express';
import { createApiRouter } from './api.js';
import { errorHandler } from '../middleware/error-handler.js';
import { SessionError } from '../../terminal/session-manager.js';
import type { AppDeps } from '../app.js';
import { createTestServer } from '../__tests__/helpers/test-server.js';
import type { TestServer } from '../__tests__/helpers/test-server.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function buildMockDeps(): AppDeps {
  return {
    sessionEngine: {
      createSession: vi.fn(),
      listSessions: vi.fn().mockReturnValue([]),
      stopSession: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn().mockReturnValue(undefined),
      getOutputSnapshot: vi.fn(),
      stopAllSessions: vi.fn().mockResolvedValue(undefined),
    } as unknown as AppDeps['sessionEngine'],
    db: {
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockReturnValue([]),
      }),
    } as unknown as AppDeps['db'],
    authConfig: {
      mode: 'none',
      token: undefined,
      oidcClientId: undefined,
      oidcClientSecret: undefined,
      oidcDiscoveryUrl: undefined,
      oidcRedirectUri: undefined,
      sessionSecret: 'test-secret',
    },
  };
}

function buildApp(deps: AppDeps): Application {
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter(deps));
  app.use(errorHandler());
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /health', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it('returns 200 with status ok', async () => {
    const res = await request(server.url).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok' });
  });
});

describe('POST /api/sessions', () => {
  let deps: AppDeps;
  let app: Application;

  beforeEach(() => {
    deps = buildMockDeps();
    app = buildApp(deps);
  });

  it('(a) missing name returns 400 VALIDATION_ERROR', async () => {
    const res = await request(app)
      .post('/api/sessions')
      .send({ repoPath: '/tmp/repo' })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('(b) valid body calls createSession and returns 201', async () => {
    const fakeSession = { sessionId: 'abc-123', worktree: {}, createdAt: new Date() };
    vi.mocked(deps.sessionEngine.createSession).mockResolvedValue(fakeSession as never);

    const res = await request(app)
      .post('/api/sessions')
      .send({ name: 'my-session', repoPath: '/tmp/repo', branch: 'main' })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(201);
    expect(deps.sessionEngine.createSession).toHaveBeenCalledOnce();
    expect(res.body.data).toBeDefined();
  });

  it('missing repoPath returns 400 VALIDATION_ERROR', async () => {
    const res = await request(app)
      .post('/api/sessions')
      .send({ name: 'my-session' })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('invalid branch name (contains ..) returns 400 INVALID_INPUT', async () => {
    const res = await request(app)
      .post('/api/sessions')
      .send({ name: 'my-session', repoPath: '/tmp/repo', branch: 'main..evil' })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });
});

describe('GET /api/sessions', () => {
  it('returns 200 with data array', async () => {
    const deps = buildMockDeps();
    vi.mocked(deps.sessionEngine.listSessions).mockReturnValue([]);
    const app = buildApp(deps);

    const res = await request(app).get('/api/sessions');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [] });
  });
});

describe('DELETE /api/sessions/:id', () => {
  let deps: AppDeps;
  let app: Application;

  beforeEach(() => {
    deps = buildMockDeps();
    app = buildApp(deps);
  });

  it('returns 204 on success', async () => {
    vi.mocked(deps.sessionEngine.stopSession).mockResolvedValue(undefined);

    const res = await request(app).delete('/api/sessions/abc-123');
    expect(res.status).toBe(204);
  });

  it('(c) engine throws NotFoundError → returns 404', async () => {
    vi.mocked(deps.sessionEngine.stopSession).mockRejectedValue(
      new SessionError('Session not found', 'NOT_FOUND'),
    );

    const res = await request(app).delete('/api/sessions/nonexistent');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('invalid id format returns 400', async () => {
    const res = await request(app).delete('/api/sessions/INVALID_ID!');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/sessions/:id/send', () => {
  let deps: AppDeps;
  let app: Application;

  beforeEach(() => {
    deps = buildMockDeps();
    app = buildApp(deps);
  });

  it('(d) null byte in text returns 400 INVALID_INPUT', async () => {
    const mockTerminal = { write: vi.fn() };
    vi.mocked(deps.sessionEngine.getSession).mockReturnValue({
      terminal: mockTerminal,
    } as never);

    const res = await request(app)
      .post('/api/sessions/abc-123/send')
      .send({ text: 'hello\x00world' })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_INPUT');
  });

  it('valid text writes to terminal and returns 200 ok:true', async () => {
    const mockTerminal = { write: vi.fn() };
    vi.mocked(deps.sessionEngine.getSession).mockReturnValue({
      terminal: mockTerminal,
    } as never);

    const res = await request(app)
      .post('/api/sessions/abc-123/send')
      .send({ text: 'ls -la' })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockTerminal.write).toHaveBeenCalledWith('ls -la');
  });

  it('session not found returns 404', async () => {
    vi.mocked(deps.sessionEngine.getSession).mockReturnValue(undefined);

    const res = await request(app)
      .post('/api/sessions/abc-123/send')
      .send({ text: 'ls' })
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(404);
  });

  it('missing text returns 400 VALIDATION_ERROR', async () => {
    const res = await request(app)
      .post('/api/sessions/abc-123/send')
      .send({})
      .set('Content-Type', 'application/json');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/instances', () => {
  it('returns 200 with data from db', async () => {
    const deps = buildMockDeps();
    const mockInstances = [{ id: 'inst-1', repo_root: '/repo', registered_at: '2024-01-01' }];
    const mockAll = vi.fn().mockReturnValue(mockInstances);
    vi.mocked(deps.db.prepare).mockReturnValue({ all: mockAll } as never);
    const app = buildApp(deps);

    const res = await request(app).get('/api/instances');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(mockInstances);
  });
});
