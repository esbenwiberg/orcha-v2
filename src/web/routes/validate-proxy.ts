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

/** Map from incoming request to its validate session ID (for the proxyRes handler). */
const reqSessionId = new WeakMap<IncomingMessage, string>();

/**
 * Inline script injected into HTML responses from the proxied validation app.
 * Wraps the native WebSocket constructor so connections opened by the page
 * (Vite HMR, Storybook server channel, etc.) are routed through the
 * /validate/:sessionId/ reverse-proxy prefix rather than hitting the host root.
 */
function wsRewriteScript(sessionId: string): string {
  // Sanitise sessionId — only allow characters valid for our session IDs
  const safe = sessionId.replace(/[^a-zA-Z0-9\-_]/g, '');
  return [
    '<script>(function(){',
    'var W=window.WebSocket,p="/validate/' + safe + '";',
    'window.WebSocket=function(u,pr){',
    'if(typeof u==="string"){try{var o=new URL(u);',
    'if(o.host===location.host&&!o.pathname.startsWith(p)){',
    'o.pathname=p+o.pathname;u=o.toString()}}',
    'catch(e){if(u.startsWith("/")&&!u.startsWith(p))u=p+u}}',
    'return pr!==undefined?new W(u,pr):new W(u)};',
    'window.WebSocket.prototype=W.prototype;',
    'window.WebSocket.CONNECTING=W.CONNECTING;',
    'window.WebSocket.OPEN=W.OPEN;',
    'window.WebSocket.CLOSING=W.CLOSING;',
    'window.WebSocket.CLOSED=W.CLOSED',
    '})()</script>',
  ].join('');
}

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
    // We handle response piping ourselves so we can inject scripts into HTML.
    selfHandleResponse: true,
  });

  // Prevent upstream compression so we can inspect/modify HTML bodies.
  // The target is localhost so there's no bandwidth benefit from compression.
  proxy.on('proxyReq', (proxyReq) => {
    proxyReq.setHeader('accept-encoding', 'identity');
  });

  // With selfHandleResponse we pipe every response ourselves, injecting a
  // WebSocket-rewriting script into HTML pages so that Vite HMR and similar
  // WebSocket clients route through the /validate/:sessionId/ prefix.
  proxy.on('proxyRes', (proxyRes, req, res) => {
    const sr = res as ServerResponse;
    // Strip Orcha's helmet CSP so the proxied app's own assets load freely
    sr.removeHeader('content-security-policy');

    const contentType = proxyRes.headers['content-type'] ?? '';
    const isHtml = contentType.includes('text/html');
    const sessionId = reqSessionId.get(req);

    if (!isHtml || !sessionId) {
      // Non-HTML (or no session context): pipe through unmodified
      sr.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
      proxyRes.pipe(sr);
      return;
    }

    // HTML: buffer body, inject WebSocket-rewriting script, send.
    const chunks: Buffer[] = [];
    proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
    proxyRes.on('end', () => {
      let body = Buffer.concat(chunks).toString('utf-8');
      const script = wsRewriteScript(sessionId);

      // Inject right after the opening <head> tag.
      const headRe = /<head([^>]*)>/i;
      if (headRe.test(body)) {
        body = body.replace(headRe, `<head$1>${script}`);
      } else {
        // No <head> — prepend to the entire response.
        body = script + body;
      }

      const headers = { ...proxyRes.headers };
      // We decoded (and possibly enlarged) the body — fix length headers.
      delete headers['content-encoding'];
      delete headers['transfer-encoding'];
      headers['content-length'] = String(Buffer.byteLength(body));

      sr.writeHead(proxyRes.statusCode ?? 200, headers);
      sr.end(body);
    });
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

    // Stash the sessionId so the proxyRes handler can inject the WS-rewrite script.
    reqSessionId.set(req, sessionId);
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
