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
 * Wraps both WebSocket and EventSource constructors so real-time connections
 * opened by the page (Vite HMR, Storybook server channel, SSE, etc.) are
 * routed through the /validate/:sessionId/ reverse-proxy prefix.
 *
 * Key fix: also intercepts connections to localhost:<any-port>, not just
 * location.host.  The proxied app may open WebSockets to its own port
 * (e.g. ws://localhost:41483/) which is unreachable from a remote browser.
 */
function connectionRewriteScript(sessionId: string): string {
  // Sanitise sessionId — only allow characters valid for our session IDs
  const safe = sessionId.replace(/[^a-zA-Z0-9\-_]/g, '');
  return [
    '<script>(function(){',
    'var p="/validate/' + safe + '";',

    // Detect local addresses — the proxied app (e.g. Storybook/Vite) may open
    // WebSockets or EventSources to localhost:<its-own-port> which differs from
    // location.host when the browser reaches Orcha through a public URL or proxy.
    'function isLocal(h){',
    'var n=h.replace(/:\\d+$/,"").toLowerCase();',
    'return n==="localhost"||n==="127.0.0.1"||n==="[::1]"||n==="0.0.0.0"||h===location.host',
    '}',

    // Rewrite a URL string: redirect local connections through the validate proxy.
    'function rw(u,httpProto){',
    'if(typeof u!=="string")return u;',
    'try{var o=new URL(u);',
    'if(isLocal(o.host)&&!o.pathname.startsWith(p)){',
    'if(httpProto){o.protocol=location.protocol}',
    'else{o.protocol=location.protocol==="https:"?"wss:":"ws:"}',
    'o.host=location.host;',
    'o.pathname=p+o.pathname;return o.toString()}}',
    'catch(e){if(u.startsWith("/")&&!u.startsWith(p))return p+u}',
    'return u}',

    // --- WebSocket wrapper ---
    'var W=window.WebSocket;',
    'window.WebSocket=function(u,pr){',
    'u=rw(u,false);',
    'return pr!==undefined?new W(u,pr):new W(u)};',
    'window.WebSocket.prototype=W.prototype;',
    'window.WebSocket.CONNECTING=W.CONNECTING;',
    'window.WebSocket.OPEN=W.OPEN;',
    'window.WebSocket.CLOSING=W.CLOSING;',
    'window.WebSocket.CLOSED=W.CLOSED;',

    // --- EventSource wrapper (Storybook server channel / SSE) ---
    'var E=window.EventSource;',
    'if(E){',
    'window.EventSource=function(u,opts){',
    'return new E(rw(u,true),opts)};',
    'window.EventSource.prototype=E.prototype;',
    'window.EventSource.CONNECTING=E.CONNECTING;',
    'window.EventSource.OPEN=E.OPEN;',
    'window.EventSource.CLOSED=E.CLOSED}',

    // --- fetch() wrapper ---
    // Rewrites absolute paths (e.g. "/api/foo") and local full URLs so HTMX
    // requests, client-side fetch calls, etc. route through the proxy prefix.
    'var F=window.fetch;',
    'window.fetch=function(u,opts){',
    'if(typeof u==="string"){u=rw(u,true)}',
    'else if(u instanceof Request&&!u.url.includes(p)){',
    'u=new Request(rw(u.url,true),u)}',
    'return F.call(this,u,opts)};',

    // --- XMLHttpRequest.open wrapper ---
    // Covers HTMX (uses XHR by default) and any other XHR-based code.
    'var XO=XMLHttpRequest.prototype.open;',
    'XMLHttpRequest.prototype.open=function(m,u){',
    'if(typeof u==="string"){u=rw(u,true)}',
    'var a=[m,u].concat(Array.prototype.slice.call(arguments,2));',
    'return XO.apply(this,a)};',

    // --- Click interception for <a> navigation ---
    // Rewrites href on anchor clicks so regular link navigation stays within
    // the proxy prefix. Only intercepts local absolute paths.
    'document.addEventListener("click",function(e){',
    'var t=e.target;',
    'while(t&&t.tagName!=="A")t=t.parentElement;',
    'if(!t)return;',
    'var h=t.getAttribute("href");',
    'if(h&&h.startsWith("/")&&!h.startsWith(p)){',
    't.setAttribute("href",p+h)}',
    '},true);',

    // --- History API wrappers ---
    // Rewrite pushState/replaceState URLs so the address bar stays prefixed
    // and back/forward navigation works correctly.
    'var PS=history.pushState,RS=history.replaceState;',
    'history.pushState=function(s,t,u){',
    'if(typeof u==="string")u=rw(u,true);',
    'return PS.call(this,s,t,u)};',
    'history.replaceState=function(s,t,u){',
    'if(typeof u==="string")u=rw(u,true);',
    'return RS.call(this,s,t,u)};',

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
  // The target is local (or host.docker.internal) so there's no bandwidth benefit.
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
      const script = connectionRewriteScript(sessionId);

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
    proxy.web(req, res as ServerResponse, { target: env.url });
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

    proxy.ws(req, socket, head, { target: env.url });
    return true; // handled
  }

  return { router, handleUpgrade };
}
