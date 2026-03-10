import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import compression from 'compression';
import { Eta } from 'eta';
import type Database from 'better-sqlite3';
import type { SessionManager } from '../terminal/session-manager.js';
import type { WorktreeManager } from '../terminal/worktree-manager.js';
import type { AuthTerminalManager } from '../terminal/auth-terminal-manager.js';
import { requestLogger } from './middleware/request-logger.js';
import { securityMiddleware } from './middleware/security.js';
import { errorHandler } from './middleware/error-handler.js';
import { dbSyncMiddleware } from './middleware/db-sync.js';
import { createApiRouter } from './routes/api.js';
import { createDashboardRouter } from './routes/dashboard.js';
import { createHealthRouter } from './routes/health.js';
import { createMobileRouter } from './routes/mobile.js';
import { createSessionsRouter } from './routes/sessions.js';
import { createPresetsRouter } from './routes/presets.js';
import { createReposRouter } from './routes/repos.js';
import { createEventsRouter } from './routes/events.js';
import { createCredentialsRouter } from './routes/credentials.js';
import { createClaudePermissionsRouter } from './routes/claude-permissions.js';
import { createClaudeFilesRouter } from './routes/claude-files.js';
import { createMcpServersRouter } from './routes/mcp-servers.js';
import { createGitIdentityRouter } from './routes/git-identity.js';
import { createSystemRouter } from './routes/system.js';
import { createModelConfigsRouter } from './routes/model-configs.js';
import { createBootstrapPatsRouter } from './routes/bootstrap-pats.js';
import { createTaskSettingsRouter } from './routes/task-settings.js';
import { createSdksRouter } from './routes/sdks.js';
import { createSkillsRouter } from './routes/skills.js';
import { createAzLoginRouter } from './routes/az-login.js';
import { createTasksRouter } from './routes/tasks.js';
import { createFeedsRouter } from './routes/feeds.js';
import { buildAuthMiddleware } from './auth/index.js';
import type { AuthConfig } from './auth/index.js';
import { createValidateMcpRouter } from '../mcp/validate-mcp.js';
import { createOrchaMcpRouter } from '../mcp/orcha-mcp.js';
import { ValidationManager } from '../validation/validation-manager.js';
import { createValidateProxy } from './routes/validate-proxy.js';
import { loadDeployConfig, Deployer } from '../deploy/index.js';
import { GlobalSettingsStore } from '../db/global-settings-store.js';
import { setBootstrapPatResolver as setDevOpsBootstrapPatResolver } from '../credentials/providers/devops.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface AppDeps {
  sessionEngine: SessionManager;
  worktreeManager: WorktreeManager;
  db: Database.Database;
  authConfig: AuthConfig;
  authTerminalManager: AuthTerminalManager;
  validationManager?: ValidationManager;
}

export interface CreateAppResult {
  app: express.Application;
  /** WebSocket upgrade handler for /validate/:sessionId — wire to server 'upgrade' event. undefined when no ValidationManager. */
  validateProxyUpgrade: ((req: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => boolean) | undefined;
}

export async function createApp(deps: AppDeps): Promise<CreateAppResult> {
  const app = express();

  // Wire bootstrap PAT resolver so DevOps provider reads from DB
  const globalSettings = new GlobalSettingsStore(deps.db);
  setDevOpsBootstrapPatResolver(() => globalSettings.get('devops_bootstrap_pat'));

  // Trust the first proxy (Caddy) so express-session sets secure cookies correctly
  app.set('trust proxy', 1);

  // Initialise ETA template engine pointing at src/web/views/
  const eta = new Eta({
    views: path.join(__dirname, 'views'),
    defaultExtension: '.html',
    cache: process.env['NODE_ENV'] === 'production',
  });

  // MCP endpoints — mounted BEFORE body parsers because the MCP SDK's
  // StreamableHTTPServerTransport reads the raw request stream. express.json()
  // would consume the stream first, causing the transport to see an empty body.
  if (deps.validationManager) {
    app.use(createValidateMcpRouter(deps.db, deps.validationManager));
  }
  app.use(createOrchaMcpRouter(deps.db));

  // Parse JSON request bodies — skip /validate/ proxy routes so the raw body
  // is forwarded intact to the proxied app.
  const jsonParser = express.json({ limit: '10mb' });
  const urlencodedParser = express.urlencoded({ extended: false });
  app.use((req, res, next) => {
    if (req.path.startsWith('/validate/')) return next();
    jsonParser(req, res, next);
  });
  app.use((req, res, next) => {
    if (req.path.startsWith('/validate/')) return next();
    urlencodedParser(req, res, next);
  });

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

  // Auto-sync DB to persistent storage after successful mutations
  app.use(dbSyncMiddleware());

  // Security headers (helmet) and CORS policy
  app.use(...securityMiddleware());

  // Health endpoint — mounted before auth so it is always reachable without credentials
  app.use('/health', createHealthRouter(deps.db));

  // Build and mount auth middleware
  const { middleware: authMiddleware, router: authRouter } = await buildAuthMiddleware(
    deps.authConfig,
  );

  // For OIDC: apply session/passport setup before the auth router,
  // then mount the auth router, then apply the auth guard after.
  // The last middleware in authMiddleware is ensureAuthenticated.
  if (authRouter !== undefined) {
    const setupMiddleware = authMiddleware.slice(0, -1);
    const guardMiddleware = authMiddleware.slice(-1);
    app.use(...setupMiddleware);
    app.use('/', authRouter);
    app.use(...guardMiddleware);
  } else {
    app.use(...authMiddleware);
  }

  // Validate proxy — reverse proxy to validation environments.
  // Mounted after auth (OIDC-protected) and before static/routes so it
  // doesn't collide with Orcha's own routes.
  let validateProxyUpgrade: CreateAppResult['validateProxyUpgrade'];
  if (deps.validationManager) {
    const vp = createValidateProxy(deps.validationManager);
    app.use(vp.router);
    validateProxyUpgrade = vp.handleUpgrade;
  }

  // Serve static assets from src/web/public
  app.use(express.static('src/web/public'));

  // Serve uploaded screenshots so thumbnails load in the browser
  app.use('/uploads/images', express.static('/tmp/orcha-images'));

  // SSE events router — must be mounted before compression can interfere
  app.use(createEventsRouter(eta));

  // Session HTMX partials router — mounted before the JSON API router so that
  // HTMX form POSTs to /api/sessions reach this handler first (the JSON API
  // validator would otherwise short-circuit them with a 400).
  app.use('/api', createSessionsRouter(eta, deps));

  // Presets HTMX partials router
  app.use('/api', createPresetsRouter(eta, deps));

  // Repos HTMX partials router
  app.use('/api', createReposRouter(eta, deps));

  // Credentials HTMX partials router
  app.use('/api', createCredentialsRouter(eta, deps));

  // Model configs HTMX partials router
  app.use('/api', createModelConfigsRouter(eta, deps));

  // Claude permissions editor router
  app.use('/api', createClaudePermissionsRouter(eta, deps.db));

  // CLAUDE.md / soul.md editor router
  app.use('/api', createClaudeFilesRouter(eta, deps.db));

  // MCP servers management router
  app.use('/api', createMcpServersRouter(eta, deps.db));

  // Skills management router
  app.use('/api', createSkillsRouter(eta, deps.db));

  // Bootstrap PATs management router
  app.use('/api', createBootstrapPatsRouter(eta, deps.db));

  // Task pipeline settings router
  app.use('/api', createTaskSettingsRouter(eta, deps.db));

  // Git identity settings router
  app.use('/api', createGitIdentityRouter(eta, deps));

  // Global SDKs settings router
  app.use('/api', createSdksRouter(eta, deps));

  // Private feeds settings router
  app.use('/api', createFeedsRouter(eta, deps.db));

  // Az login (session-scoped + host-scoped device code flow)
  app.use('/api', createAzLoginRouter(eta, deps));

  // Tasks pipeline router
  app.use('/api', createTasksRouter(eta, deps));

  // Self-deploy (optional — only if DEPLOY_* env vars are set)
  const deployConfig = loadDeployConfig();
  const deployer = deployConfig ? new Deployer(deployConfig) : null;

  // System stats + disk cleanup router
  app.use('/api', createSystemRouter(eta, deps, deployer, deployConfig));

  // JSON API routes
  app.use('/api', createApiRouter(deps));

  // Mobile shell
  app.use('/mobile', createMobileRouter(eta, deps));

  // Dashboard (replaces stub pages router)
  app.use('/', createDashboardRouter(eta));

  // Error handler must be last (Express identifies 4-argument functions as error handlers)
  app.use(errorHandler());

  return { app, validateProxyUpgrade };
}
