import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import compression from 'compression';
import { Eta } from 'eta';
import type Database from 'better-sqlite3';
import type { SessionManager } from '../terminal/session-manager.js';
import { requestLogger } from './middleware/request-logger.js';
import { securityMiddleware } from './middleware/security.js';
import { errorHandler } from './middleware/error-handler.js';
import { createApiRouter } from './routes/api.js';
import { createDashboardRouter } from './routes/dashboard.js';
import { createHealthRouter } from './routes/health.js';
import { createMobileRouter } from './routes/mobile.js';
import { createSessionsRouter } from './routes/sessions.js';
import { createPresetsRouter } from './routes/presets.js';
import { createEventsRouter } from './routes/events.js';
import { buildAuthMiddleware } from './auth/index.js';
import type { AuthConfig } from './auth/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface AppDeps {
  sessionEngine: SessionManager;
  db: Database.Database;
  authConfig: AuthConfig;
}

export async function createApp(deps: AppDeps): Promise<express.Application> {
  const app = express();

  // Initialise ETA template engine pointing at src/web/views/
  const eta = new Eta({
    views: path.join(__dirname, 'views'),
    defaultExtension: '.html',
    cache: process.env['NODE_ENV'] === 'production',
  });

  // Parse JSON request bodies
  app.use(express.json());

  // Parse URL-encoded form bodies (for HTMX form submissions)
  app.use(express.urlencoded({ extended: false }));

  // Compress responses, but exclude SSE streams
  app.use(
    compression({
      filter: (req, res) => {
        if (res.getHeader('Content-Type') === 'text/event-stream') return false;
        return compression.filter(req, res);
      },
    }),
  );

  // Log all requests (first middleware)
  app.use(requestLogger());

  // Security headers (helmet) and CORS policy
  app.use(...securityMiddleware());

  // Health endpoint — mounted before auth so it is always reachable without credentials
  app.use('/health', createHealthRouter(deps.db));

  // Build and mount auth middleware
  const { middleware: authMiddleware, router: authRouter } = await buildAuthMiddleware(
    deps.authConfig,
  );

  // Mount the OIDC auth router (login/callback/logout) before protected routes
  if (authRouter !== undefined) {
    app.use('/', authRouter);
  }

  // Apply auth middleware to all subsequent routes
  app.use(...authMiddleware);

  // Serve static assets from src/web/public
  app.use(express.static('src/web/public'));

  // SSE events router — must be mounted before compression can interfere
  app.use(createEventsRouter(eta));

  // Session HTMX partials router — mounted before the JSON API router so that
  // HTMX form POSTs to /api/sessions reach this handler first (the JSON API
  // validator would otherwise short-circuit them with a 400).
  app.use('/api', createSessionsRouter(eta, deps));

  // Presets HTMX partials router
  app.use('/api', createPresetsRouter(eta, deps));

  // JSON API routes
  app.use('/api', createApiRouter(deps));

  // Mobile shell
  app.use('/mobile', createMobileRouter(eta, deps));

  // Dashboard (replaces stub pages router)
  app.use('/', createDashboardRouter(eta));

  // Error handler must be last (Express identifies 4-argument functions as error handlers)
  app.use(errorHandler());

  return app;
}
