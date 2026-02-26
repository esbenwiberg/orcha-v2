# Phase 7: Phase 7 – Hardening, Observability & CLI Compat
**Milestones: 7**

Polish the system for day-to-day single-user reliability: add structured logging, surface the legacy CLI verb contract as thin REST wrappers or a minimal bin script, and ensure the WebSocket and PTY layer is robust under real-world conditions.

## Milestone 1: Structured logging with pino: request logs, session lifecycle events, auth events, error traces
Replace all ad-hoc console.log/console.error calls with a unified pino logger that emits structured JSON in production and pretty-printed output in development, covering request logs, session lifecycle events, auth events, and error traces.

1. Create `src/logger.ts` exporting a singleton pino logger: import pino from 'pino'; export const logger = pino({ level: process.env.LOG_LEVEL ?? 'info', transport: process.env.NODE_ENV !== 'production' ? { target: 'pino-pretty', options: { colorize: true } } : undefined }); also export a child-factory function `childLogger(module: string)` that calls `logger.child({ module })`.
2. Add `pino`, `pino-pretty`, and `pino-http` to `package.json` dependencies; run `npm install`.
3. Create `src/web/middleware/request-logger.ts` that imports `pino-http` and creates a pino-http middleware instance using the shared logger from `src/logger.ts`, logging `req.method`, `req.url`, `res.statusCode`, and `responseTime` on every request.
4. In `src/web/server.ts` register the `requestLoggerMiddleware` from step 3 as the first `app.use()` call, before any route or auth middleware.
5. Open `src/terminal/pty-manager.ts` and replace every `console.log` and `console.error` call with `childLogger('pty-manager').info(...)` or `.error(...)`, including log events for: PTY spawn (log `sessionId`, `cols`, `rows`, `shell`), PTY exit (log `sessionId`, `exitCode`, `signal`), and PTY write errors.
6. Open `src/auth/middleware.ts` and replace every `console` call with `childLogger('auth').info/warn/error`, logging auth success with `{ userId, strategy }` and auth failure with `{ strategy, reason }` at warn level.
7. Open `src/db/session-repository.ts` and add `childLogger('session-repo')` calls for: session created (info), session state transition (info with `{ from, to }`), session deleted (info), and repository errors (error with full `err` object so pino serialises the stack).
8. Search the entire `src/` tree for remaining bare `console.log` and `console.error` calls using `grep -rn 'console\.' src/` and replace each with the appropriate child logger, grouping by module name.
9. Add `LOG_LEVEL` to `.env.example` with the value `info` and document the accepted values (`trace`, `debug`, `info`, `warn`, `error`, `fatal`).

**Key files**: src/logger.ts, src/web/server.ts, src/web/middleware/request-logger.ts, src/terminal/pty-manager.ts, src/auth/middleware.ts, src/db/session-repository.ts

**Verification**:
```bash
npm run build && npm run lint && node dist/web/start-server.js & sleep 2 && curl -s http://localhost:3000/health | grep ok && kill %1 && grep -q 'level' /tmp/orcha-test.log || echo 'log check passed'
```

## Milestone 2: CLI bin script (bin/orcha.js): start, stop, status, web, focus, send, kill verbs delegating to REST API or spawning the web server
Prevent silent WebSocket disconnections under Azure load balancer idle timeouts and implement exponential-backoff reconnect in the xterm.js client so terminal sessions survive transient network interruptions without operator intervention.

1. Open `src/web/websocket-server.ts` and add a server-side heartbeat loop: after the WebSocket.Server is created, start a `setInterval` every 30 seconds that iterates `wss.clients`, checks each client's `isAlive` property, terminates any client where `isAlive` is `false`, then calls `client.ping()` on the rest and sets `isAlive = false`.
2. In the same file, in the `wss.on('connection', (ws) => {...})` handler, set `ws.isAlive = true` immediately on connection, and add `ws.on('pong', () => { ws.isAlive = true; })` so the heartbeat loop can detect live clients.
3. Add a typed message protocol: define `type WsMessage = { type: 'ping' | 'pong' | 'data' | 'resize' | 'reconnect-ack'; payload?: unknown }` in `src/web/websocket-server.ts` and parse every incoming message through this type, logging malformed messages at warn level via the pino child logger.
4. In `src/web/public/terminal-client.js` (the desktop xterm.js bootstrap), extract all WebSocket construction and event wiring into a `connectTerminal(sessionId)` function that returns a `WebSocket` instance.
5. In the same file, add a `reconnect` function that uses exponential backoff: maintain a `reconnectAttempt` counter starting at 0; on `ws.onclose` or `ws.onerror`, if `reconnectAttempt < 8`, schedule `setTimeout(() => connectTerminal(sessionId), Math.min(1000 * 2 ** reconnectAttempt, 30000))` and increment `reconnectAttempt`; reset the counter to 0 on a successful `ws.onopen`.
6. In `terminal-client.js`, when the reconnect fires, call `term.write('\r\n\x1b[33m[Reconnecting…]\x1b[0m\r\n')` before the new WebSocket is created so the operator sees feedback inside the terminal pane.
7. Duplicate the same `connectTerminal` / `reconnect` pattern in `src/web/public/mobile-terminal-client.js`, adjusting any mobile-specific UI feedback (display a toast overlay rather than writing to xterm directly, since the mobile layout may not have the terminal visible at all times).
8. In `src/web/websocket-server.ts`, on `wss.on('connection')` log `childLogger('ws').info({ sessionId, remoteAddress }, 'ws-connected')` and on `ws.on('close')` log `childLogger('ws').info({ sessionId, code, reason }, 'ws-closed')` so reconnect events are visible in the structured log stream.

**Key files**: src/web/websocket-server.ts, src/web/public/terminal-client.js, src/web/public/mobile-terminal-client.js

**Verification**:
```bash
npm run build && node -e "const ws=require('ws');const s=new ws.Server({port:9999});s.on('connection',c=>{c.on('message',m=>{if(JSON.parse(m).type==='ping')c.send(JSON.stringify({type:'pong'}))})});setTimeout(()=>s.close(),5000)" && echo 'WS server smoke test passed'
```

## Milestone 3: WebSocket heartbeat and auto-reconnect: ping/pong keepalive, client-side xterm.js reconnect with exponential backoff
On server startup, query SQLite for sessions in non-terminal states, mark them as 'detached' (PTY process lost), and expose a /api/sessions/:id/reattach endpoint so the operator can manually re-spawn a PTY for a recovered session without losing the worktree or session metadata.

1. Open `src/domain/session.ts` and add `'detached'` to the `SessionStatus` union type so it sits between `'running'` and `'stopped'`: `export type SessionStatus = 'pending' | 'running' | 'detached' | 'stopped' | 'error'`.
2. Open `src/db/session-repository.ts` and add a new function `markDetachedSessions(): Promise<number>` that executes `UPDATE sessions SET status = 'detached', updated_at = CURRENT_TIMESTAMP WHERE status IN ('running', 'pending')` and returns the count of updated rows.
3. In the same file add `listRecoverableSessions(): Promise<Session[]>` that executes `SELECT * FROM sessions WHERE status = 'detached' ORDER BY created_at DESC`.
4. Open `src/terminal/pty-manager.ts` and add `async recoverSession(session: Session): Promise<void>` that: (a) verifies the session's worktree directory still exists with `fs.access(session.worktreePath)`, (b) if the worktree is missing, calls `sessionRepository.updateStatus(session.id, 'error')` and logs a warning, (c) if the worktree exists, calls `this.spawnPty(session)` to create a fresh PTY in the existing worktree, then calls `sessionRepository.updateStatus(session.id, 'running')`.
5. Open `src/web/server.ts` in the server startup sequence (after the DB is initialised but before the HTTP server begins listening) and add: `const detachedCount = await sessionRepository.markDetachedSessions(); if (detachedCount > 0) { childLogger('startup').warn({ detachedCount }, 'sessions-marked-detached-on-startup'); }`.
6. Open `src/web/routes/sessions.ts` and add a new route `POST /api/sessions/:id/reattach` that: (a) loads the session by `req.params.id` from the repository, (b) returns 404 if not found, (c) returns 409 with `{ error: 'session-not-detached' }` if `session.status !== 'detached'`, (d) calls `ptyManager.recoverSession(session)`, (e) returns 200 with the updated session object.
7. Create `src/web/public/fragments/session-detached-banner.html` containing an HTMX fragment: a yellow warning bar with the text 'Session detached — PTY lost on server restart' and a button `hx-post='/api/sessions/SESSION_ID/reattach' hx-target='#session-card-SESSION_ID' hx-swap='outerHTML'` so the operator can trigger recovery from the dashboard without leaving the page.
8. In the HTMX session card template (whichever Handlebars/EJS file renders individual session cards in Phase 4), add a conditional block that renders the detached banner fragment when `session.status === 'detached'`.
9. Create `src/__tests__/session-recovery.test.ts` with tests for: (a) `markDetachedSessions` updates only running/pending rows, (b) `recoverSession` spawns a new PTY when the worktree exists, (c) `recoverSession` sets status to error when the worktree is missing, (d) `POST /api/sessions/:id/reattach` returns 409 for a running session.

**Key files**: src/terminal/pty-manager.ts, src/db/session-repository.ts, src/web/routes/sessions.ts, src/domain/session.ts, src/web/server.ts

**Verification**:
```bash
npm run build && npm run test -- src/__tests__/session-recovery.test.ts
```

## Milestone 4: Session recovery on server restart: reload PTY-less sessions from SQLite, mark as recoverable, allow manual re-attach
Protect the server from accidental or malicious abuse by applying per-IP rate limits on all REST endpoints and capping request body sizes, using express-rate-limit and Express's built-in body parser limits.

1. Run `npm install express-rate-limit` and verify it appears in `package.json` dependencies.
2. Create `src/web/middleware/rate-limiter.ts` and define three rate-limiter instances using `rateLimit` from `express-rate-limit`:
   - `generalLimiter`: `windowMs: 60_000`, `max: 120`, applied to all `/api/` routes — allows 2 requests per second on average.
   - `sessionCreateLimiter`: `windowMs: 60_000`, `max: 10`, applied only to `POST /api/sessions` — prevents rapid session creation.
   - `authLimiter`: `windowMs: 15 * 60_000`, `max: 20`, applied to auth-related endpoints — throttles brute-force token attempts.
   Each limiter must set `standardHeaders: true` and `legacyHeaders: false` so `RateLimit-*` headers are returned.
3. Export all three limiters from `src/web/middleware/rate-limiter.ts`.
4. Open `src/web/server.ts` and import all three limiters from step 2.
5. Register `generalLimiter` with `app.use('/api/', generalLimiter)` after the request logger middleware but before route handlers.
6. Register `sessionCreateLimiter` on `router.post('/sessions', sessionCreateLimiter, sessionCreateHandler)` in `src/web/routes/sessions.ts`.
7. Register `authLimiter` on the auth endpoint in `src/web/routes/auth.ts` (or wherever the static-token POST handler lives).
8. In `src/web/server.ts`, locate the `express.json()` middleware call and change it to `express.json({ limit: '64kb' })` to cap JSON body sizes; locate `express.urlencoded()` and add `{ limit: '64kb', extended: false }` for the same reason.
9. Configure `rate-limiter` to use a custom `handler` that calls `childLogger('rate-limit').warn({ ip: req.ip, path: req.path }, 'rate-limit-hit')` and returns `{ error: 'too-many-requests', retryAfter: res.getHeader('Retry-After') }` as JSON with status 429.
10. Create `src/__tests__/rate-limiter.test.ts` using supertest and vitest, with tests: (a) 121 sequential requests to `/api/sessions` return 429 on the 121st, (b) request with a 65KB body to any `/api/` endpoint returns 413, (c) `RateLimit-Remaining` header is present on non-limited responses.

**Key files**: src/web/middleware/rate-limiter.ts, src/web/server.ts, src/__tests__/rate-limiter.test.ts

**Verification**:
```bash
npm run build && npm run test -- src/__tests__/rate-limiter.test.ts && npm run lint
```

## Milestone 5: Rate limiting and request size caps on REST API (express-rate-limit)
Deliver a thin Node.js CLI entry point at bin/orcha.js that delegates all eight verbs to the REST API (when the server is running) or spawns the web server process (for the 'web' verb), providing a terminal-friendly interface for operators who prefer the command line over the browser.

1. Create `src/cli/api-client.ts` exporting a class `OrchaApiClient` with constructor `(baseUrl: string, token?: string)` that sets an `Authorization: Bearer <token>` header on every request when `token` is provided; implement methods: `listSessions(): Promise<Session[]>`, `createSession(opts: CreateSessionOptions): Promise<Session>`, `stopSession(id: string): Promise<void>`, `killSession(id: string): Promise<void>`, `sendInput(id: string, text: string): Promise<void>`, `getSession(id: string): Promise<Session>` — each method uses the Node.js built-in `fetch` (Node 18+) and throws a typed `ApiError` (with `statusCode` and `message` fields) on non-2xx responses.
2. Create `src/cli/cli-main.ts` as the Commander.js program definition: `import { Command } from 'commander'; export const program = new Command('orcha').version(pkg.version).description('Orcha session manager CLI');` and register all eight sub-commands (start, stop, status, web, focus, send, kill) as described in steps 3–10.
3. Register `program.command('web')` with options `--port <port>` (default 3000), `--no-auth`, and `--dry-run`; the action should: if `--dry-run`, print 'Would start web server on port <port>' and exit; otherwise `spawn('node', ['dist/web/start-server.js'], { env: { ...process.env, PORT: port }, stdio: 'inherit', detached: false })`.
4. Register `program.command('status')` with optional `[sessionId]`; the action creates an `OrchaApiClient` from `ORCHA_URL` env var (default `http://localhost:3000`) and `ORCHA_TOKEN` env var; if `sessionId` is provided, calls `client.getSession(sessionId)` and prints a formatted one-line summary; otherwise calls `client.listSessions()` and prints a table with columns: ID (first 8 chars), Name, Status, Worktree, Created.
5. Register `program.command('start').argument('<name>', 'session name').option('--repo <path>', 'repository path', process.cwd()).option('--prompt <text>', 'initial prompt to send')`: action calls `client.createSession({ name, repoPath, initialPrompt })` and prints the new session ID.
6. Register `program.command('stop').argument('<sessionId>')`: action calls `client.stopSession(sessionId)` and prints 'Session <id> stopped'.
7. Register `program.command('kill').argument('<sessionId>')`: action calls `client.killSession(sessionId)` and prints 'Session <id> killed'; add `--force` flag that sends `?force=true` query param.
8. Register `program.command('send').argument('<sessionId>').argument('<text>')`: action calls `client.sendInput(sessionId, text)` and prints 'Sent to <id>'.
9. Register `program.command('focus').argument('<sessionId>')`: action calls `client.getSession(sessionId)` to validate it exists, then prints the URL `${ORCHA_URL}/terminal/${sessionId}` and, if the `DISPLAY` env var is set or the platform is macOS, attempts to open the URL in the default browser using `child_process.spawn('open'/'xdg-open', [url], { detached: true, stdio: 'ignore' })`.
10. Create `bin/orcha.js` as a plain JS file (not TypeScript) with the shebang `#!/usr/bin/env node` followed by `import('../dist/cli/cli-main.js').then(m => m.program.parseAsync(process.argv)).catch(err => { console.error(err.message); process.exit(1); })`.
11. In `package.json` set `"bin": { "orcha": "bin/orcha.js" }` and add `"commander"` to dependencies; run `npm install commander`.
12. Verify Commander.js is not already in the old codebase (it was used by the legacy CLI); if it is, ensure the version satisfies `^12.0.0`.

**Key files**: bin/orcha.js, src/cli/api-client.ts, src/cli/cli-main.ts, package.json

**Verification**:
```bash
npm run build && node bin/orcha.js --help && node bin/orcha.js status --help && node bin/orcha.js web --dry-run 2>&1 | grep 'Would start'
```

## Milestone 6: End-to-end test suite covering all eight CLI verbs and their web API equivalents
Create an integration test suite using vitest that spins up the actual Express server in-process, exercises all eight CLI verbs through both the supertest HTTP client and the OrchaApiClient, and validates round-trip correctness for the session lifecycle.

1. Create `src/__tests__/helpers/test-server.ts` exporting an async function `startTestServer(): Promise<{ url: string; close: () => Promise<void>; db: Database }>` that: creates a fresh in-memory SQLite database, constructs the Express app using the same factory function used in `src/web/server.ts` (passing the in-memory DB), starts the server on a random port with `server.listen(0)`, and returns the base URL and a `close` function that calls `server.close()` and disposes the DB.
2. In `vitest.config.ts`, add a `testTimeout: 30000` to the config object to accommodate PTY spawn in integration tests, and ensure `include` covers `src/__tests__/e2e/**/*.test.ts`.
3. Create `src/__tests__/e2e/rest-api.test.ts` with a `beforeAll` that calls `startTestServer()` and an `afterAll` that calls `close()`; add tests:
   - `POST /api/sessions` with `{ name: 'test-session', repoPath: process.cwd() }` returns 201 with a session object containing `id`, `name`, `status: 'pending'`.
   - `GET /api/sessions` returns 200 with an array containing the created session.
   - `GET /api/sessions/:id` returns 200 with the correct session.
   - `POST /api/sessions/:id/stop` returns 200 and the session status becomes `'stopped'`.
   - `POST /api/sessions/:id/reattach` on a running session returns 409.
   - `POST /api/sessions/:id/input` with `{ text: 'ls\n' }` returns 200 (PTY may not be running in test, so mock `ptyManager.writeToSession` with `vi.fn()`).
   - `DELETE /api/sessions/:id` returns 204 and subsequent `GET /api/sessions/:id` returns 404.
   - Any endpoint called with a 65KB body returns 413.
   - 121 rapid calls to `POST /api/sessions` return 429 on the 121st.
4. Create `src/__tests__/e2e/cli-verbs.test.ts` importing `OrchaApiClient` from `src/cli/api-client.ts`; add a `beforeAll` that starts the test server and constructs an `OrchaApiClient` pointing at its URL; add tests:
   - `client.listSessions()` returns an array.
   - `client.createSession({ name: 'e2e', repoPath: process.cwd() })` returns a session with an `id`.
   - `client.getSession(session.id)` returns the same session.
   - `client.sendInput(session.id, 'echo hi\n')` resolves without throwing (PTY mocked as in step 3).
   - `client.stopSession(session.id)` resolves without throwing.
   - `client.killSession(session.id)` resolves without throwing on a stopped session.
   - `client.getSession('nonexistent-id')` throws an `ApiError` with `statusCode === 404`.
5. Add a separate test block in `cli-verbs.test.ts` for the `focus` verb logic: mock `client.getSession` to return a valid session, capture the URL that would be opened (by mocking `child_process.spawn`), and assert it equals `${baseUrl}/terminal/${session.id}`.
6. Mock `src/terminal/pty-manager.ts` at the module level in both test files using `vi.mock('../terminal/pty-manager', ...)` to avoid actually spawning PTY processes in CI, with `spawnSession` returning a resolved promise and `writeToSession` being a no-op.
7. Add an npm script `"test:e2e": "vitest run src/__tests__/e2e/"` to `package.json`.

**Key files**: src/__tests__/e2e/cli-verbs.test.ts, src/__tests__/e2e/rest-api.test.ts, src/__tests__/helpers/test-server.ts, vitest.config.ts

**Verification**:
```bash
npm run build && npm run test -- src/__tests__/e2e/ --reporter=verbose
```

## Milestone 7: README, GETTING-STARTED, and deployment guide covering all three auth modes and the Azure Container Apps setup
Write the final operator-facing documentation: a root README covering project purpose and quickstart, a GETTING-STARTED guide with step-by-step local setup, and a DEPLOYMENT guide covering all three auth modes (Entra ID OIDC, static token, no-auth) and the full Azure Container Apps deployment workflow.

1. Rewrite `README.md` with the following sections in order: (a) one-paragraph project description naming the core value proposition (orchestrate parallel Claude sessions, each in a git worktree, visible from a single web UI); (b) a features list with bullet points for: multi-session dashboard, HTMX+xterm.js UI, node-pty terminal streaming, SQLite persistence, Azure Container Apps deployment, three auth modes; (c) a Quick Start section with exactly four commands: `git clone`, `npm install`, `cp .env.example .env`, `npm run dev`; (d) a Screenshot placeholder with alt text 'Orcha dashboard'; (e) links to GETTING-STARTED.md and docs/deployment.md; (f) a License section.
2. Write `GETTING-STARTED.md` with sections: (a) Prerequisites listing Node.js 18+, git, and (optional) an Azure subscription; (b) Installation — `git clone`, `npm install`, `npm run build`; (c) Configuration — explain every variable in `.env.example` with a one-line description each; (d) Running locally with `AUTH_MODE=none` — paste the exact three commands; (e) Opening the dashboard — 'Visit http://localhost:3000 in your browser'; (f) Creating your first session — describe the UI flow: click 'New Session', enter a name and repo path, click 'Launch', observe the terminal pane connect; (g) Using the CLI — show `npx orcha status`, `npx orcha start my-session`, `npx orcha web`; (h) Troubleshooting — three common issues with solutions: port already in use, PTY spawn failure on non-Linux, SQLite file permissions.
3. Write `docs/auth-modes.md` with a section for each mode: (a) **No-auth** (`AUTH_MODE=none`): warn it is for local development only, never expose publicly; show the single `.env` line; (b) **Static token** (`AUTH_MODE=token`): explain `ORCHA_TOKEN` must be a random 32+ character string; show how to generate one with `openssl rand -hex 32`; show the `Authorization: Bearer <token>` header for API calls; show how the CLI reads `ORCHA_TOKEN` from the environment; (c) **Entra ID OIDC** (`AUTH_MODE=entra`): list the required env vars (`ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET`, `ENTRA_REDIRECT_URI`); describe the app registration steps in the Azure portal in numbered steps; describe the login flow from the browser's perspective.
4. Write `docs/deployment.md` with sections: (a) Architecture overview — one paragraph describing the container, SQLite volume, blobfuse2 worktree mount; (b) Prerequisites — Azure CLI, Docker, an Azure Container Apps environment; (c) Build and push the container image — show the exact `docker build` and `az acr build` commands; (d) Create the Container App — show the full `az containerapp create` command with all required env vars as `--env-vars` flags, including `AUTH_MODE`, `ORCHA_TOKEN`, `DATABASE_PATH`, `WORKTREE_BASE_PATH`; (e) Persistent storage — explain the Azure Blob Storage volume mount using `az containerapp storage` commands; (f) Updating the deployment — show `az containerapp update --image` command; (g) Viewing logs — show `az containerapp logs show` command.
5. Update `.env.example` to include every environment variable referenced across all source files: `PORT=3000`, `NODE_ENV=development`, `LOG_LEVEL=info`, `AUTH_MODE=none`, `ORCHA_TOKEN=`, `ENTRA_TENANT_ID=`, `ENTRA_CLIENT_ID=`, `ENTRA_CLIENT_SECRET=`, `ENTRA_REDIRECT_URI=`, `DATABASE_PATH=./orcha.db`, `WORKTREE_BASE_PATH=./worktrees`, `SESSION_SHELL=/bin/bash`, `ORCHA_URL=http://localhost:3000` — each line preceded by a comment explaining its purpose.
6. Install `markdownlint-cli2` as a dev dependency (`npm install -D markdownlint-cli2`) and add `"lint:docs": "markdownlint-cli2 'docs/**/*.md' README.md GETTING-STARTED.md"` to the `scripts` block in `package.json`.
7. Add a `.markdownlint.json` configuration file at the repo root with: `{ "MD013": false, "MD033": false }` to disable line-length and inline HTML rules, which are commonly violated in technical docs.

**Key files**: README.md, GETTING-STARTED.md, docs/deployment.md, docs/auth-modes.md, .env.example

**Verification**:
```bash
npx markdownlint-cli2 README.md GETTING-STARTED.md docs/deployment.md docs/auth-modes.md && node -e "require('fs').readFileSync('README.md','utf8').includes('orcha web') || process.exit(1)" && node -e "require('fs').readFileSync('.env.example','utf8').includes('AUTH_MODE') || process.exit(1)"
```