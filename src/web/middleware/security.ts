import type express from 'express';
import helmet from 'helmet';
import cors from 'cors';

// `unsafe-inline` is permitted for script-src because xterm.js writes inline
// styles to the DOM and the project deliberately avoids a client-side build
// pipeline in this phase. `unsafe-eval` is required because htmx uses
// new Function() to evaluate JS expressions in hx-on / hx-vals attributes.
// Remove both when a bundler-based nonce strategy is added.
const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      'script-src-attr': ["'unsafe-inline'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'connect-src': ["'self'", 'wss:', 'ws:'],
      'img-src': ["'self'", 'data:'],
    },
  },
  // Disabled to avoid breaking SharedArrayBuffer usage; xterm.js does not
  // require cross-origin isolation and this header can block legitimate loads.
  crossOriginEmbedderPolicy: false,
});

const corsMiddleware = cors({
  origin: ['http://localhost:3000', 'http://127.0.0.1:3000'],
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
});

export function securityMiddleware(): express.RequestHandler[] {
  return [
    helmetMiddleware as express.RequestHandler,
    corsMiddleware as express.RequestHandler,
  ];
}
