/**
 * Smoke-test for GET /mobile/status-stream (M6).
 *
 * Verifies that:
 *   1. The endpoint sets Content-Type: text/event-stream.
 *   2. It emits at least one SSE event named `connStatus` within a reasonable timeout.
 *
 * The session engine is mocked so no real PTY is needed.
 */

import http from 'node:http';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestServer } from './helpers/test-server.js';
import type { TestServer } from './helpers/test-server.js';

// ---------------------------------------------------------------------------
// OIDC mock — must be hoisted so Vitest applies it before module import.
// ---------------------------------------------------------------------------
vi.mock('../auth/oidc-auth.js', () => {
  const noopMiddleware = (_req: unknown, _res: unknown, next: () => void) => next();
  const buildOidcAuth = vi.fn().mockResolvedValue({
    initialize: noopMiddleware,
    session: noopMiddleware,
    ensureAuthenticated: noopMiddleware,
    router: undefined,
  });
  return { buildOidcAuth };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Open a raw HTTP connection to the SSE endpoint and collect the first
 * `maxBytes` bytes of the response body.  Resolves as soon as the first
 * chunk arrives or `timeoutMs` elapses.
 */
function collectSseChunk(url: string, timeoutMs = 7000): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);

    const req = http.get(
      {
        hostname: parsedUrl.hostname,
        port: Number(parsedUrl.port),
        path: parsedUrl.pathname,
        headers: { Accept: 'text/event-stream' },
      },
      (res) => {
        let body = '';

        const timer = setTimeout(() => {
          req.destroy();
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
        }, timeoutMs);

        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
          // Resolve as soon as we have enough content to validate.
          if (body.includes('event: connStatus')) {
            clearTimeout(timer);
            req.destroy();
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
          }
        });

        res.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      },
    );

    req.on('error', (err) => {
      // Ignore ECONNRESET caused by our own req.destroy() call.
      if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') return;
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('GET /mobile/status-stream', () => {
  let server: TestServer;

  beforeAll(async () => {
    // No active session — the stream should still emit 'disconnected' events.
    server = await createTestServer({ mode: 'none' });
  });

  afterAll(async () => {
    await server.close();
  });

  it('responds with Content-Type: text/event-stream', async () => {
    const { status, headers } = await collectSseChunk(`${server.url}/mobile/status-stream`);
    expect(status).toBe(200);
    expect(headers['content-type']).toMatch(/text\/event-stream/);
  });

  it('emits an event named connStatus within 8 seconds', async () => {
    const { body } = await collectSseChunk(`${server.url}/mobile/status-stream`, 8000);
    expect(body).toContain('event: connStatus');
  });

  it('connStatus event data contains a conn-badge span', async () => {
    const { body } = await collectSseChunk(`${server.url}/mobile/status-stream`);
    // Verify the HTML payload looks like the badge markup.
    expect(body).toContain('conn-badge');
    expect(body).toContain('id="conn-badge"');
  });

  it('initial event is sent immediately (body available within 2 seconds)', async () => {
    const { body } = await collectSseChunk(`${server.url}/mobile/status-stream`, 2000);
    expect(body).toContain('event: connStatus');
  });
});
