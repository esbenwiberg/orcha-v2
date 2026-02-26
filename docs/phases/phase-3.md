# Phase 3: Phase 3 – Web Server: Express + WebSocket + Auth
**Milestones: 7**

Stand up the HTTP and WebSocket server with all auth modes wired in. This is the integration layer between the terminal backend and the UI. Auth must be solid before any UI is built so it is never bolted on after the fact.

## Milestone 1: Express app scaffold: static asset serving, JSON API routes, error middleware, graceful shutdown
Create the foundational Express application with all route groups stubbed, static asset serving configured, structured error middleware, and SIGTERM/SIGINT graceful shutdown so every subsequent milestone has a stable server to plug into.

1. Create `src/web/app.ts` that exports a single `createApp(deps: AppDeps): express.Application` factory function. Import `express`, `compression`, and `express.json()`. Mount `express.static('src/web/public')` at `/` for serving future HTML/CSS/JS assets. Return the configured app instance without starting it so the factory is testable in isolation.
2. Define `interface AppDeps` in `src/web/app.ts` with fields `sessionEngine: SessionEngine` (from Phase 2) and `db: Database` (from Phase 1), keeping the factory decoupled from singletons.
3. Create `src/web/middleware/request-logger.ts` exporting `requestLogger(): express.RequestHandler`. Log method, path, status, and duration using `console.error` (stderr) in a compact single-line format: `[timestamp] METHOD /path STATUS ms`. Mount this as the first middleware in `createApp`.
4. Create `src/web/middleware/error-handler.ts` exporting `errorHandler(): express.ErrorRequestHandler`. The handler must check for an `AppError` shape (fields: `statusCode: number`, `message: string`, optional `code: string`). For `AppError` return `{ error: { code, message } }` with the given status. For unknown errors return 500 with `{ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } }` and log the full error to stderr. Never leak stack traces to the response body.
5. Create `src/web/routes/api.ts` exporting `createApiRouter(deps: AppDeps): express.Router`. Add a stub `GET /health` route that returns `{ status: 'ok', timestamp: new Date().toISOString() }` with HTTP 200. Add placeholder comments for the four session CRUD routes and instances route that will be wired in M3.4.
6. Create `src/web/routes/pages.ts` exporting `createPagesRouter(): express.Router`. Add a stub `GET /` route that returns a minimal HTML string `<html><body><h1>Orcha</h1></body></html>` with `Content-Type: text/html`. This will be replaced by real templates in Phase 4.
7. In `createApp`, mount `createApiRouter(deps)` at `/api` and `createPagesRouter()` at `/`. Mount `errorHandler()` as the final middleware (Express identifies 4-argument functions as error handlers).
8. Create `src/web/server.ts` exporting `startServer(deps: AppDeps, port: number): Promise<http.Server>`. Call `createApp(deps)` then `server.listen(port, '127.0.0.1', ...)` — bind to loopback only. Return the `http.Server` instance wrapped in a Promise that resolves on the `listening` event.
9. In `startServer`, register `process.on('SIGTERM', ...)` and `process.on('SIGINT', ...)` handlers. Each handler calls `server.close(cb)` which stops accepting new connections, then calls `deps.sessionEngine.shutdown()` (Phase 2 lifecycle hook), then exits with code 0. Use a 10-second forced-exit fallback via `setTimeout(..., 10_000).unref()`.
10. Update `src/web/start-server.ts` to import `startServer`, create stub `deps` objects (or real ones if Phase 1/2 are available), read `PORT` from `process.env` (default 3000), and call `startServer(deps, port)`. Log `Orcha listening on http://127.0.0.1:PORT` on startup.

**Key files**: src/web/app.ts, src/web/server.ts, src/web/routes/api.ts, src/web/routes/pages.ts, src/web/middleware/error-handler.ts, src/web/middleware/request-logger.ts, src/web/public/placeholder.txt, src/web/start-server.ts

**Verification**:
```bash
npm run build && node dist/web/start-server.js & sleep 1 && curl -sf http://localhost:3000/health && curl -sf http://localhost:3000/ | grep -q 'Orcha' && kill %1
```

## Milestone 2: Auth middleware: environment-variable-driven selection of no-auth, static bearer token, or Entra ID OIDC (passport.js + openid-client)
Add helmet.js for HTTP security headers and a CORS policy that accepts requests only from the loopback origin, preventing browser-based CSRF and clickjacking while preserving the HTMX same-origin fetch model.

1. Install `helmet` and `cors` packages: `npm install helmet cors` and `npm install --save-dev @types/cors`.
2. Create `src/web/middleware/security.ts` exporting `securityMiddleware(): express.RequestHandler[]`. Return an array of middleware so they can be spread-mounted in sequence.
3. Inside `securityMiddleware`, configure `helmet()` with explicit options: `contentSecurityPolicy` set to directives `default-src 'self'`, `script-src 'self' 'unsafe-inline'` (required for inline xterm.js initialisation in Phase 4), `style-src 'self' 'unsafe-inline'`, `connect-src 'self' ws://127.0.0.1:*`, `img-src 'self' data:`. Set `crossOriginEmbedderPolicy: false` to avoid breaking SharedArrayBuffer use that xterm.js does not require.
4. Configure `cors()` with `origin: ['http://localhost:3000', 'http://127.0.0.1:3000']`, `methods: ['GET', 'POST', 'DELETE']`, `allowedHeaders: ['Content-Type', 'Authorization']`, `credentials: false`. This prevents cross-origin JS from calling the API from a different port.
5. In `src/web/app.ts` `createApp`, import `securityMiddleware` and spread the returned array as the second middleware block, immediately after `requestLogger` and before the route mounts. Order is: requestLogger → ...securityMiddleware() → routes → errorHandler.
6. Add a `GET /api/health` test using `curl -sI` to verify the `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, and `X-DNS-Prefetch-Control: off` response headers are present.
7. Document in a comment above the CSP configuration in `security.ts` the reason `unsafe-inline` is permitted for scripts: xterm.js writes inline style to the DOM and the project avoids a build pipeline for client JS in this phase.

**Key files**: src/web/app.ts, src/web/middleware/security.ts

**Verification**:
```bash
npm run build && node dist/web/start-server.js & sleep 1 && curl -sI http://localhost:3000/health | grep -i 'x-content-type-options' && curl -sI http://localhost:3000/health | grep -i 'x-frame-options' && kill %1
```

## Milestone 3: WebSocket upgrade handler: /ws/terminal/:id route, PTY stream piped to ws client, resize messages, indefinite read timeout
Implement the three authentication modes — no-auth (local dev), static bearer token, and Entra ID OIDC via passport.js + openid-client — each selected by environment variables at startup with zero runtime switching. Auth middleware must be fully functional before any REST or WebSocket routes are exposed.

1. Create `src/web/auth/types.ts` and define `interface AuthenticatedUser { id: string; name?: string; email?: string; }`. Extend Express's `Request` interface by declaring `namespace Express { interface Request { user?: AuthenticatedUser; } }` in the same file using module augmentation so all route handlers get typed access to `req.user`.
2. Define `type AuthMode = 'none' | 'token' | 'oidc'` and export `interface AuthConfig` with fields: `mode: AuthMode`, `token?: string` (for mode=token), `oidcClientId?: string`, `oidcClientSecret?: string`, `oidcDiscoveryUrl?: string`, `oidcRedirectUri?: string`, `sessionSecret: string`. Export `function loadAuthConfig(): AuthConfig` that reads `AUTH_MODE` env var (default `'none'`), `AUTH_TOKEN`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_DISCOVERY_URL`, `OIDC_REDIRECT_URI`, `SESSION_SECRET` (default to a random 32-byte hex string with a console.warn if missing in non-none mode).
3. Create `src/web/auth/no-auth.ts` exporting `noAuthMiddleware(): express.RequestHandler`. The handler sets `req.user = { id: 'local', name: 'Local User' }` and calls `next()`.
4. Create `src/web/auth/token-auth.ts` exporting `tokenAuthMiddleware(token: string): express.RequestHandler`. Extract the value from the `Authorization` header by splitting on `'Bearer '`. If missing or the token does not match using `crypto.timingSafeEqual` (after padding both to equal length as `Buffer`), call `next(createAppError(401, 'Unauthorized', 'AUTH_REQUIRED'))`. Otherwise set `req.user = { id: 'operator', name: 'Operator' }` and call `next()`. Use `crypto.timingSafeEqual` to prevent timing attacks on the secret comparison.
5. Create `src/web/auth/oidc-auth.ts`. Install `passport`, `passport-strategy`, `openid-client`, `express-session`, and types: `npm install passport openid-client express-session && npm install --save-dev @types/passport @types/express-session`. Export async `buildOidcAuth(config: AuthConfig): Promise<{ initialize: express.RequestHandler; session: express.RequestHandler; ensureAuthenticated: express.RequestHandler; router: express.Router }>`. Inside, use `openid-client`'s `Issuer.discover(config.oidcDiscoveryUrl)` to fetch the provider metadata. Create a `Client` instance. Register a `passport.use` strategy using the discovered client. Return `initialize` as `passport.initialize()`, `session` as `passport.session()`, and `ensureAuthenticated` as a middleware that checks `req.isAuthenticated()`; if false, for API routes (path starts with `/api`) return 401 JSON, otherwise redirect to `/auth/login`. The returned `router` exposes `GET /auth/login` (redirects to the OIDC authorization endpoint), `GET /auth/callback` (handles the authorization code exchange), and `GET /auth/logout` (destroys session and redirects to `/`).
6. Create `src/web/auth/index.ts` exporting `async function buildAuthMiddleware(config: AuthConfig): Promise<{ middleware: express.RequestHandler[]; router?: express.Router }>`. Switch on `config.mode`: `'none'` → returns `{ middleware: [noAuthMiddleware()] }`; `'token'` → returns `{ middleware: [tokenAuthMiddleware(config.token!)] }`; `'oidc'` → calls `buildOidcAuth(config)`, adds `express-session` with `config.sessionSecret` to the middleware array before the passport middlewares, returns the router. Throw a startup error if mode is `'oidc'` and any of `oidcClientId`, `oidcClientSecret`, `oidcDiscoveryUrl` are absent.
7. In `src/web/app.ts` `createApp`, add `authConfig: AuthConfig` to `AppDeps`. Change `createApp` to be async: `async function createApp(deps: AppDeps)`. Call `await buildAuthMiddleware(deps.authConfig)` and mount the returned middleware array after security middleware and before the API/pages routers. If a router is returned (OIDC case), mount it at `/` before the protected routers.
8. Update `src/web/server.ts` `startServer` to be async and await `createApp(deps)`.
9. Update `src/web/start-server.ts` to call `loadAuthConfig()` and pass the result into `AppDeps`.
10. Write unit tests in `src/web/auth/token-auth.test.ts`: test (a) missing Authorization header returns 401, (b) wrong token returns 401, (c) correct token sets `req.user` and calls next. Mock `next` as a vitest spy.

**Key files**: src/web/auth/types.ts, src/web/auth/no-auth.ts, src/web/auth/token-auth.ts, src/web/auth/oidc-auth.ts, src/web/auth/index.ts, src/web/app.ts

**Verification**:
```bash
npm run build && npm test -- src/web/auth/ && AUTH_MODE=none node dist/web/start-server.js & sleep 1 && curl -sf http://localhost:3000/api/health && kill %1 && AUTH_MODE=token AUTH_TOKEN=secret node dist/web/start-server.js & sleep 1 && curl -sf -H 'Authorization: Bearer secret' http://localhost:3000/api/health && curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/api/health | grep 401 && kill %1
```

## Milestone 4: REST API routes: POST /api/sessions, GET /api/sessions, DELETE /api/sessions/:id, POST /api/sessions/:id/send, GET /api/instances
Wire the four session management REST endpoints and the instances listing endpoint to the SessionEngine from Phase 2, with request validation, sanitised inputs, and proper HTTP semantics.

1. Create `src/web/utils/sanitise.ts`. Export `function sanitiseShellArg(value: string): string` that rejects (throws `AppError(400, 'Invalid argument', 'INVALID_INPUT')`) any string containing characters outside `[a-zA-Z0-9._/@:-]` after trimming. Export `function sanitiseBranchName(value: string): string` that additionally rejects values containing `..`, starting with `-`, or containing whitespace. Export `function sanitisePath(value: string): string` that calls `path.resolve(value)` and rejects any path that does not start with `/` (i.e. after resolution). These functions are pure and throw typed `AppError` instances on invalid input.
2. Create `src/web/utils/git-utils.ts`. Export `async function executeGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }>`. Validate each arg by calling `sanitiseShellArg(arg)` before spawning. Use `child_process.spawn('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })` — never `exec` or `execSync`. Buffer stdout and stderr. Reject on non-zero exit with an `AppError(500, stderr, 'GIT_ERROR')`. The `GIT_TERMINAL_PROMPT: '0'` env var prevents git from hanging waiting for credentials.
3. Create `src/web/middleware/validate.ts` exporting `function validateBody<T>(schema: ZodSchema<T>): express.RequestHandler`. Use `zod` (install if not already present: `npm install zod`). Parse `req.body` with `schema.safeParse`. On failure, collect all `issues` into a readable message string and call `next(createAppError(400, message, 'VALIDATION_ERROR'))`. On success, replace `req.body` with the parsed (and type-coerced) result and call `next()`.
4. Define Zod schemas in `src/web/routes/api.ts`: `CreateSessionSchema = z.object({ name: z.string().min(1).max(100), repoPath: z.string().min(1), branch: z.string().optional(), prompt: z.string().optional() })` and `SendInputSchema = z.object({ text: z.string().min(1).max(4096) })`.
5. In `createApiRouter` in `src/web/routes/api.ts`, implement `POST /sessions`: call `validateBody(CreateSessionSchema)`, then call `sanitisePath(req.body.repoPath)` and `sanitiseBranchName(req.body.branch)` if branch is provided. Call `deps.sessionEngine.createSession({ name, repoPath, branch, prompt })`. Return `201` with `{ data: session }` where `session` is the domain `Session` object from Phase 1/2.
6. Implement `GET /sessions`: call `deps.sessionEngine.listSessions()`. Return `200` with `{ data: sessions }`. If the engine throws, let the error propagate to `errorHandler`.
7. Implement `DELETE /sessions/:id`: validate `:id` matches `/^[a-z0-9-]{1,64}$/` (inline regex, throw `AppError(400)` if not). Call `deps.sessionEngine.terminateSession(req.params.id)`. On `NotFoundError` from the engine return 404. On success return `204` with no body.
8. Implement `POST /sessions/:id/send`: validate `:id` as above. Call `validateBody(SendInputSchema)`. Sanitise `req.body.text` — reject if it contains null bytes (`\x00`). Call `deps.sessionEngine.sendInput(req.params.id, req.body.text)`. Return `200` with `{ ok: true }`.
9. Implement `GET /instances`: call `deps.db.all('SELECT * FROM instances ORDER BY created_at DESC')` (or the equivalent Phase 1 repository method). Return `200` with `{ data: instances }`.
10. Write route tests in `src/web/routes/api.test.ts` using `supertest`. Mock `deps.sessionEngine` with vitest spies. Test: (a) `POST /sessions` with missing `name` returns 400, (b) `POST /sessions` with valid body calls `createSession` and returns 201, (c) `DELETE /sessions/nonexistent` when engine throws `NotFoundError` returns 404, (d) `POST /sessions/:id/send` with null byte in text returns 400.

**Key files**: src/web/routes/api.ts, src/web/utils/sanitise.ts, src/web/utils/git-utils.ts, src/web/middleware/validate.ts

**Verification**:
```bash
npm run build && npm test -- src/web/routes/ src/web/utils/ && AUTH_MODE=none node dist/web/start-server.js & sleep 1 && curl -sf -X POST http://localhost:3000/api/sessions -H 'Content-Type: application/json' -d '{"name":"test","repoPath":"/tmp"}' | grep -q 'id' && kill %1
```

## Milestone 5: Shell injection sanitisation utility and git utility wrappers (executeGit)
Attach a WebSocket server to the HTTP server and implement the /ws/terminal/:id route that pipes PTY output to the browser and routes browser keystrokes and resize messages back to the PTY process, with auth enforcement on the upgrade.

1. Install `ws` package: `npm install ws && npm install --save-dev @types/ws`.
2. Create `src/web/ws/ws-server.ts` exporting `function attachWebSocketServer(server: http.Server, deps: AppDeps): WebSocket.Server`. Create a `new WebSocket.Server({ noServer: true })`. Listen on `server.on('upgrade', (req, socket, head) => { ... })`. In the upgrade handler, parse `req.url` with the `URL` constructor to extract the pathname. If the pathname does not match `/ws/terminal/` prefix, destroy the socket with `socket.destroy()` and return.
3. Inside the upgrade handler in `src/web/ws/ws-server.ts`, enforce authentication before completing the WebSocket handshake. Read the `Authorization` header from `req.headers`. Based on `deps.authConfig.mode`: for `'none'` always allow; for `'token'` compare using `crypto.timingSafeEqual` as in M3.3; for `'oidc'` parse the session cookie using the same `express-session` store and check `req.session?.passport?.user`. If auth fails, write `HTTP/1.1 401 Unauthorized

` to the socket and destroy it. Do NOT upgrade the connection.
4. On successful auth, call `wss.handleUpgrade(req, socket, head, (ws) => { wss.emit('connection', ws, req) })` to complete the WebSocket handshake.
5. Create `src/web/ws/terminal-ws.ts` exporting `function handleTerminalConnection(ws: WebSocket, sessionId: string, engine: SessionEngine): void`. Call `engine.getPtyStream(sessionId)` to get the `IPtyProcess` from Phase 2. If the session is not found, send a JSON message `{ type: 'error', message: 'Session not found' }` and close with code 4004.
6. In `handleTerminalConnection`, subscribe to PTY stdout: `pty.onData((data: string) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'output', data })) })`. Use JSON envelope so the client can distinguish output from control messages.
7. Listen on `ws.on('message', (raw: Buffer) => { ... })`. Parse `raw.toString()` as JSON. Handle two message types: `{ type: 'input', data: string }` — call `pty.write(data)`; `{ type: 'resize', cols: number, rows: number }` — validate cols and rows are integers in `[1, 500]` then call `pty.resize(cols, rows)`. Ignore malformed or unrecognised message types (log to stderr, do not throw).
8. Set `ws.on('close', () => { /* PTY data subscription cleanup — unsubscribe onData listener */ })`. Store the disposable returned by `pty.onData` and call `.dispose()` in the close handler to prevent memory leaks when a client disconnects without terminating the session.
9. Set no ping/pong timeout on the WebSocket server (`clientTracking: false` ping is not needed) but configure a 30-second server-side ping interval: in `attachWebSocketServer`, run `setInterval(() => { wss.clients.forEach(client => { if (client.readyState === WebSocket.OPEN) client.ping() }) }, 30_000)` to detect silently dropped connections.
10. In `attachWebSocketServer`'s connection handler, extract `sessionId` from the pathname (`/ws/terminal/:id` → split on `/ws/terminal/`). Call `handleTerminalConnection(ws, sessionId, deps.sessionEngine)`.
11. In `src/web/server.ts` `startServer`, after creating the `http.Server`, call `attachWebSocketServer(server, deps)`. WebSocket and HTTP share the same port via the upgrade mechanism.
12. Write a unit test in `src/web/ws/terminal-ws.test.ts` that mocks `engine.getPtyStream` returning a mock PTY with an `onData` spy, creates a mock WebSocket, sends a `resize` message with cols=80 rows=24, and asserts `pty.resize(80, 24)` was called.

**Key files**: src/web/ws/terminal-ws.ts, src/web/ws/ws-server.ts, src/web/server.ts

**Verification**:
```bash
npm run build && npm test -- src/web/ws/ && AUTH_MODE=none node dist/web/start-server.js & sleep 1 && node -e "const ws=require('ws');const c=new ws('ws://localhost:3000/ws/terminal/test-id');c.on('error',e=>process.exit(e.message.includes('404')?0:1));" && kill %1
```

## Milestone 6: CORS and security headers (helmet.js); localhost-only bind with HTTPS expected from Caddy
Write integration tests that start the full Express+WebSocket server with each auth mode and verify that unauthenticated requests are rejected, valid credentials pass, invalid credentials are rejected, and the OIDC redirect flow is triggered correctly — giving confidence that auth works before the UI is built on top.

1. Create `src/web/__tests__/helpers/test-server.ts` exporting `async function createTestServer(authConfig: Partial<AuthConfig>): Promise<{ url: string; wsUrl: string; close: () => Promise<void> }>`. Inside, create a stub `SessionEngine` mock using `vi.fn()` with `createSession`, `listSessions`, `terminateSession`, `sendInput`, `getPtyStream` all returning sensible defaults (empty arrays, resolved promises). Create a stub `Database` mock. Call the real `createApp({ sessionEngine, db, authConfig: { ...defaultAuthConfig, ...authConfig } })` and start it on port 0 (random available port) so tests do not conflict. Resolve the actual bound port from `server.address().port`. Return the URL and a `close` function that calls `server.close()`.
2. In `src/web/__tests__/auth-integration.test.ts`, import `createTestServer`, `supertest`, and `ws` (WebSocket client). Group tests with `describe` blocks per auth mode.
3. Write the `no-auth` suite: (a) start server with `{ mode: 'none' }`. (b) Test `GET /api/health` without any Authorization header returns 200. (c) Test `GET /api/sessions` returns 200 and `{ data: [] }`. (d) Close server in `afterAll`.
4. Write the `token` suite: (a) start server with `{ mode: 'token', token: 'test-secret-abc' }`. (b) Test `GET /api/sessions` with no Authorization header returns 401 and body contains `{ error: { code: 'AUTH_REQUIRED' } }`. (c) Test with `Authorization: Bearer wrong-token` returns 401. (d) Test with `Authorization: Bearer test-secret-abc` returns 200. (e) Test that a partial token (correct prefix, extra suffix) returns 401 — verifies timing-safe comparison does not short-circuit on prefix match. (f) Close server.
5. Write the `oidc` suite without a real Entra ID tenant: (a) start server with `{ mode: 'oidc', oidcClientId: 'cid', oidcClientSecret: 'csec', oidcDiscoveryUrl: 'https://login.microsoftonline.com/common/v2.0', oidcRedirectUri: 'http://localhost/auth/callback', sessionSecret: 'test-session-secret' }`. Since the discovery URL is external and tests must not make real HTTP calls, mock `Issuer.discover` from `openid-client` using `vi.mock('openid-client', ...)` to return a fake issuer that has a client constructor returning a fake client. (b) Test `GET /api/sessions` without auth returns 401. (c) Test `GET /` without auth returns 302 redirect to `/auth/login`. (d) Test `GET /auth/login` returns 302 with a `Location` header pointing to the fake authorization endpoint. (e) Close server.
6. Write a WebSocket auth test: start server with `{ mode: 'token', token: 'ws-secret' }`. Attempt a WebSocket connection to `ws://localhost:{port}/ws/terminal/sess-1` without Authorization header. Assert the connection closes with an error (the server should return 401 on upgrade). Then connect with `{ headers: { Authorization: 'Bearer ws-secret' } }` and assert the connection opens successfully (readyState OPEN). The mock `SessionEngine.getPtyStream` returns a mock PTY with a no-op `onData`.
7. Ensure all tests use `afterAll` to close servers and `vi.restoreAllMocks()` to clean up mocks. Add `--forceExit` to the vitest config for this test file (network connections can keep the process alive).

**Key files**: src/web/__tests__/auth-integration.test.ts, src/web/__tests__/helpers/test-server.ts

**Verification**:
```bash
npm run build && npm test -- src/web/__tests__/auth-integration.test.ts --reporter=verbose
```

## Milestone 7: Auth integration tests: unauthenticated requests rejected, token auth passes, OIDC redirect flow
---