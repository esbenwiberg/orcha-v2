import http from 'node:http';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { vi } from 'vitest';
import { createApp } from '../../app.js';
import type { AppDeps } from '../../app.js';
import { attachWebSocketServer } from '../../ws/ws-server.js';
import type { AuthConfig } from '../../auth/index.js';
import type { ActiveSession } from '../../../terminal/session-manager.js';

const DEFAULT_AUTH_CONFIG: AuthConfig = {
  mode: 'none',
  token: undefined,
  oidcClientId: undefined,
  oidcClientSecret: undefined,
  oidcDiscoveryUrl: undefined,
  oidcRedirectUri: undefined,
  sessionSecret: 'test-session-secret',
};

export interface TestServer {
  url: string;
  wsUrl: string;
  close: () => Promise<void>;
}

/**
 * Build a minimal mock ActiveSession whose terminal exposes a readable output
 * stream. Used by WebSocket integration tests that need a live session.
 */
export function buildMockActiveSession(sessionId = 'test-session'): ActiveSession {
  const output = new Readable({ read() {} });

  const terminal = {
    sessionId,
    pid: 9999,
    exitCode: undefined,
    output,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    on: vi.fn(),
  };

  return {
    sessionId,
    dbSessionId: undefined,
    worktree: {} as ActiveSession['worktree'],
    terminal: terminal as unknown as ActiveSession['terminal'],
    outputBuffer: { snapshot: () => Buffer.alloc(0), push: vi.fn() } as unknown as ActiveSession['outputBuffer'],
    createdAt: new Date(),
  };
}

/**
 * Start a full Express + WebSocket server on a random port (0) for integration
 * testing. The returned `close` function shuts down the HTTP server and waits
 * for any open connections to drain.
 */
export async function createTestServer(
  authConfig: Partial<AuthConfig> = {},
  sessionEngineOverrides: Partial<AppDeps['sessionEngine']> = {},
): Promise<TestServer> {
  const mergedAuthConfig: AuthConfig = { ...DEFAULT_AUTH_CONFIG, ...authConfig };

  const sessionEngine: AppDeps['sessionEngine'] = {
    createSession: vi.fn().mockResolvedValue(undefined),
    listSessions: vi.fn().mockReturnValue([]),
    stopSession: vi.fn().mockResolvedValue(undefined),
    getSession: vi.fn().mockReturnValue(undefined),
    getSessionByDbId: vi.fn().mockReturnValue(undefined),
    getOutputSnapshot: vi.fn().mockReturnValue(Buffer.alloc(0)),
    stopAllSessions: vi.fn().mockResolvedValue(undefined),
    ...sessionEngineOverrides,
  } as unknown as AppDeps['sessionEngine'];

  const db: AppDeps['db'] = {
    prepare: vi.fn().mockReturnValue({
      all: vi.fn().mockReturnValue([]),
      get: vi.fn().mockReturnValue(undefined),
      run: vi.fn().mockReturnValue({ changes: 0 }),
    }),
  } as unknown as AppDeps['db'];

  const worktreeManager = {} as AppDeps['worktreeManager'];
  const authTerminalManager = {
    startSession: vi.fn().mockReturnValue('test-auth-token'),
    getSession: vi.fn().mockReturnValue(undefined),
    stopSession: vi.fn(),
  } as unknown as AppDeps['authTerminalManager'];
  const deps: AppDeps = { sessionEngine, worktreeManager, db, authConfig: mergedAuthConfig, authTerminalManager };

  const { app } = await createApp(deps);
  const server = http.createServer(app);
  attachWebSocketServer(server, deps);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}`;

  const close = (): Promise<void> =>
    new Promise((resolve, reject) => {
      server.close((err) => {
        if (err !== undefined && err !== null) {
          reject(err);
        } else {
          resolve();
        }
      });
    });

  return { url, wsUrl, close };
}
