import { Router, type Request, type Response } from 'express';
import httpProxy from 'http-proxy';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { ValidationManager } from '../../validation/validation-manager.js';

const VALIDATE_PREFIX = '/validate/';

/**
 * Parse a raw URL like /validate/:sessionId/foo?bar=1 into parts.
 * Used for WebSocket upgrades (which don't go through Express routing).
 */
function parseValidatePath(url: string): { sessionId: string; rest: string } | null {
  const qIdx = url.indexOf('?');
  const pathname = qIdx !== -1 ? url.slice(0, qIdx) : url;
  if (!pathname.startsWith(VALIDATE_PREFIX)) return null;

  const afterPrefix = pathname.slice(VALIDATE_PREFIX.length);
  const slashIdx = afterPrefix.indexOf('/');
  if (slashIdx === -1) {
    return { sessionId: afterPrefix, rest: '/' };
  }
  return {
    sessionId: afterPrefix.slice(0, slashIdx),
    rest: afterPrefix.slice(slashIdx) || '/',
  };
}

const ERROR_PAGE = (sessionId: string) => `<!DOCTYPE html>
<html><head><title>No Validation Environment</title></head>
<body style="font-family:system-ui;padding:2rem;background:#1a1a2e;color:#e0e0e0;max-width:600px;margin:2rem auto">
  <h2>No validation environment running</h2>
  <p>Session <code>${sessionId.slice(0, 12)}…</code> doesn't have an active validation environment.</p>
  <p>The agent needs to call <code>validate_start</code> first.</p>
  <p style="margin-top:2rem"><a href="/" style="color:#7c8aff">← Back to Orcha</a></p>
</body></html>`;

/**
 * Create a reverse proxy for validation environments.
 *
 * Returns:
 * - `router` — Express router for HTTP requests at /validate/:sessionId/*
 * - `handleUpgrade` — handler for WebSocket upgrades on the same paths
 */
export function createValidateProxy(validationManager: ValidationManager) {
  const proxy = httpProxy.createProxyServer({
    changeOrigin: true,
    ws: true,
    // Don't add X-Forwarded-* headers — the proxied app doesn't need them
    xfwd: false,
  });

  // Strip Orcha's helmet CSP so the proxied app's own assets load freely
  proxy.on('proxyRes', (_proxyRes, _req, res) => {
    (res as ServerResponse).removeHeader('content-security-policy');
  });

  proxy.on('error', (err, _req, res) => {
    console.error('[validate-proxy] proxy error:', err.message);
    if ('writeHead' in res && typeof res.writeHead === 'function') {
      const sr = res as ServerResponse;
      if (!sr.headersSent) {
        sr.writeHead(502, { 'Content-Type': 'text/plain' });
        sr.end('Proxy error: validation app unreachable');
      }
    }
  });

  // --- Express router for HTTP ---
  const router = Router();

  // Express strips /validate/:sessionId from req.url, so the proxy
  // naturally forwards only the remaining path to the target.
  router.use('/validate/:sessionId', (req: Request, res: Response) => {
    const rawId = req.params['sessionId'];
    const sessionId = typeof rawId === 'string' ? rawId : '';
    const env = validationManager.status(sessionId);

    if (!env) {
      res.status(503).type('html').send(ERROR_PAGE(sessionId));
      return;
    }

    proxy.web(req, res as ServerResponse, { target: `http://localhost:${env.port}` });
  });

  // --- WebSocket upgrade handler ---
  // Register on the HTTP server's 'upgrade' event.
  // Raw upgrade requests don't go through Express, so we parse the URL manually.
  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const parsed = parseValidatePath(req.url ?? '');
    if (!parsed) return false; // not a validate path — caller should try other handlers

    const env = validationManager.status(parsed.sessionId);
    if (!env) {
      socket.destroy();
      return true; // handled (by destroying)
    }

    // Rewrite URL to strip /validate/:sessionId prefix, preserving query string
    const qIdx = (req.url ?? '').indexOf('?');
    const query = qIdx !== -1 ? (req.url ?? '').slice(qIdx) : '';
    req.url = parsed.rest + query;

    proxy.ws(req, socket, head, { target: `http://localhost:${env.port}` });
    return true; // handled
  }

  return { router, handleUpgrade };
}
