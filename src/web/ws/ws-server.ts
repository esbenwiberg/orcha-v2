import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import type { AppDeps } from '../app.js';
import { timingSafeCompare } from '../auth/token-auth.js';
import { handleTerminalConnection } from './terminal-ws.js';
import { consumeTicket } from './ws-tickets.js';

const WS_TERMINAL_PREFIX = '/ws/terminal/';
const WS_AUTH_PREFIX = '/ws/auth/';

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

    // Only handle known WS paths — destroy anything else.
    const isTerminal = pathname.startsWith(WS_TERMINAL_PREFIX);
    const isAuth = pathname.startsWith(WS_AUTH_PREFIX);
    if (!isTerminal && !isAuth) {
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
        // OIDC session cookies aren't available at the HTTP upgrade layer.
        // The browser fetches a one-time ticket via GET /api/ws-ticket (which
        // goes through normal OIDC middleware) and passes it as ?ticket=.
        const ticket = url.searchParams.get('ticket');
        if (ticket !== null) {
          authed = consumeTicket(ticket);
        }
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

  // Handle new WebSocket connections: route by path prefix.
  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = url.pathname;

    if (pathname.startsWith(WS_AUTH_PREFIX)) {
      const token = pathname.slice(WS_AUTH_PREFIX.length);
      const authSession = deps.authTerminalManager.getSession(token);

      if (authSession === undefined) {
        ws.send(JSON.stringify({ type: 'error', message: 'Auth session not found' }));
        ws.close(4004);
        return;
      }

      const onData = (chunk: Buffer | string): void => {
        if (ws.readyState === WebSocket.OPEN) {
          const data = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
          ws.send(JSON.stringify({ type: 'output', data }));
        }
      };
      authSession.terminal.output.on('data', onData);

      const sendExitMessage = (): void => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'output', data: '\r\n\x1b[33m[process exited]\x1b[0m\r\n' }));
        }
      };
      authSession.terminal.output.once('end', sendExitMessage);

      // Replay buffered output so content shown before WS connected isn't lost
      const snapshot = authSession.outputBuffer.snapshot();
      if (snapshot.length > 0 && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'output', data: snapshot.toString('utf8') }));
      }
      if (authSession.terminal.exitCode !== undefined) sendExitMessage();

      ws.on('message', (raw: Buffer) => {
        let msg: unknown;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (typeof msg !== 'object' || msg === null) return;
        const r = msg as Record<string, unknown>;
        if (r['type'] === 'input' && typeof r['data'] === 'string') {
          authSession.terminal.write(r['data']);
        } else if (r['type'] === 'resize' && typeof r['cols'] === 'number' && typeof r['rows'] === 'number') {
          authSession.terminal.resize({ cols: r['cols'] as number, rows: r['rows'] as number });
        }
      });

      ws.on('close', () => {
        authSession.terminal.output.removeListener('data', onData);
        authSession.terminal.output.removeListener('end', sendExitMessage);
      });
      return;
    }

    // Regular session terminal
    const sessionId = pathname.slice(WS_TERMINAL_PREFIX.length);
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
