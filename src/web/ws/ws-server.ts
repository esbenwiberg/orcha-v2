import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import type { AppDeps } from '../app.js';
import { timingSafeCompare } from '../auth/token-auth.js';
import { handleTerminalConnection } from './terminal-ws.js';

const WS_TERMINAL_PREFIX = '/ws/terminal/';

/**
 * Attach a WebSocket server to an existing HTTP server.
 * WebSocket and HTTP share the same port via the HTTP upgrade mechanism.
 *
 * Auth is enforced on the upgrade request before the handshake is completed.
 */
export function attachWebSocketServer(
  server: http.Server,
  deps: AppDeps,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    // Only handle /ws/terminal/:id — destroy anything else.
    if (!pathname.startsWith(WS_TERMINAL_PREFIX)) {
      socket.destroy();
      return;
    }

    // --- Auth enforcement ---
    const authHeader = req.headers['authorization'];
    const { authConfig } = deps;

    let authed = false;

    switch (authConfig.mode) {
      case 'none':
        authed = true;
        break;

      case 'token': {
        const token = authConfig.token;
        if (
          token !== undefined &&
          authHeader !== undefined &&
          authHeader.startsWith('Bearer ')
        ) {
          const provided = authHeader.slice('Bearer '.length);
          authed = timingSafeCompare(token, provided);
        }
        break;
      }

      case 'oidc': {
        // TODO: OIDC sessions rely on cookies that are not available in the
        // upgrade handler without a full session parsing pipeline.  For
        // programmatic WebSocket clients we could fall back to comparing a
        // bearer token against oidcClientSecret, but that conflates an OIDC
        // secret with an API token.  For now, WebSocket connections are denied
        // in OIDC mode; a proper solution would involve forwarding the
        // session cookie through a helper endpoint or issuing a short-lived
        // ticket token after OIDC login.
        authed = false;
        break;
      }
    }

    if (!authed) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  // Handle new WebSocket connections: extract the session id and delegate.
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const sessionId = url.pathname.slice(WS_TERMINAL_PREFIX.length);

    handleTerminalConnection(ws, sessionId, deps.sessionEngine);
  });

  // Server-side keep-alive: ping all connected clients every 30 seconds to
  // detect silently dropped connections.
  // unref() prevents this timer from keeping the process alive after the server closes.
  setInterval(() => {
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.ping();
      }
    });
  }, 30_000).unref();

  return wss;
}
