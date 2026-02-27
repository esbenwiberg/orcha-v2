# Blueprint: Orcha – Greenfield Terminal Session Manager (HTMX + Containers)
**Phases: 7**

## Summary
This redesign starts fresh from an empty repository, stripping Orcha down to its essential value proposition: orchestrating multiple parallel Claude AI coding sessions, each in its own git worktree and terminal, visible from a single web UI. All pipeline automation, TUI dashboards, Blessed/Ink rendering, and scripting subsystems are dropped entirely. The new stack centers on a lightweight Node.js/TypeScript backend serving HTMX-driven HTML fragments over HTTP, with WebSocket connections for live terminal streaming via xterm.js (retained as the best in-browser terminal emulator), while tmux is replaced by node-pty for direct PTY management — eliminating the tmux binary dependency and enabling clean container deployments.

The deployment target shifts from a bare Linux VM to Azure Container Apps, with session worktrees stored on Azure Blob Storage (mounted via blobfuse2 or managed through the API directly) rather than Azure Files, sidestepping the known git-on-Azure-Files POSIX locking issues. State persistence moves from /tmp flat files to a lightweight SQLite database bundled with the container, giving the single-user operator durable session history and audit logs across restarts without introducing a managed database service. Authentication is first-class and built-in, supporting multiple strategies (Entra ID OIDC, static token, and optional no-auth for local use) configured via environment variables at startup.

The visual design adopts the Hive UI aesthetic (https://github.com/esbenwiberg/hive) with blue as the primary accent color, rendered server-side via HTMX partial swaps for the desktop dashboard and a separate mobile-optimised single-terminal page. The result is a dramatically simpler, more deployable, and more maintainable tool that stays true to its single-user focus: launch sessions, watch them run, interact when needed, clean up when done.

## Non-Goals
- Pipeline automation stages (architect, dev, gate, fix-loop, ship) — entirely removed
- TUI dashboards (Blessed, Ink/React terminal UIs) — removed
- MCP server and Model Context Protocol integration — removed
- CLI status-bar rendering and tmux status bar integration — removed
- Handlebars prompt template management system — removed
- Gate agents (code review, security review, adversary, build/lint/test runners) — removed
- Escalation manager, fix-loop, learning/metrics subsystems — removed
- Multi-user or team namespacing beyond the single operator
- Competing fix runner and parallel strategy evaluation — removed
- Azure DevOps provider and VCS PR creation pipelines — removed (basic git push remains)
- React, Ink, or any client-side JS framework (HTMX only)
- Mobile PWA push notifications and service worker offline support in v1
- Migrating or preserving any existing codebase artifacts

## Acceptance Criteria
- A fresh `docker build && docker run` produces a working Orcha instance with zero external service dependencies beyond node-pty and git
- The web UI (desktop) renders a session grid matching the Hive blue-accented design, served entirely as HTMX HTML fragments with no client-side JS framework
- Creating a session spins up a git worktree and a node-pty PTY; the terminal is live in the browser via xterm.js WebSocket within 3 seconds
- The mobile page (/mobile) renders a single-terminal full-screen view optimised for touch with the same HTMX architecture
- Session state (id, branch, status, created_at) survives a container restart via SQLite persistence
- At least three auth modes work: no-auth (localhost), static bearer token, and Entra ID OIDC — selectable via environment variable
- Worktree data persists across container restarts when Azure Blob Storage (blobfuse2) is configured as the worktree mount
- All eight CLI verbs (start, stop, status, watch, web, focus, send, kill) either map to equivalent web API endpoints or are re-exposed as thin REST wrappers
- The instance registry API (listInstances, getInstance, registerInstance, unregisterInstance) is preserved and backed by SQLite
- xterm.js terminal WebSocket connections survive indefinite idle periods without disconnecting
- CI pipeline (GitHub Actions) builds the Docker image, runs unit tests, and pushes to a container registry on merge to main
- A single `orcha web` command starts the server; no separate TUI process is needed

## Risks
- **[high]** node-pty in a container requires native compilation and a compatible libc/glibc; Alpine-based images may fail — *Mitigation: Use a Debian-slim base image; pin node-pty version; add native build tools to the Dockerfile; test PTY functionality in CI with the actual container image*
- **[high]** Azure Blob Storage via blobfuse2 has limited POSIX semantics; git operations (especially worktree add/remove) may behave unexpectedly — *Mitigation: Use an Azure Container Apps ephemeral volume (NFS-backed Azure Files with nconnect tuning) for the worktree directory, or store worktrees on the container's local ephemeral disk and persist only the bare git repo to Blob; document the trade-off explicitly*
- **[medium]** HTMX server-sent partial swaps and WebSocket terminal streams coexist on the same Express server; routing conflicts or buffering issues may arise — *Mitigation: Separate WebSocket upgrade handling from Express middleware early in the architecture; use distinct URL namespaces (/ws/terminal/:id vs /ui/*)*
- **[low]** xterm.js bundle size (~600 KB) and Monaco are heavy for an HTMX-first page; lazy loading may be needed — *Mitigation: Load xterm.js only on terminal panels via dynamic import or a dedicated script tag; Monaco is not needed (removed with pipeline templates)*
- **[medium]** SQLite in a container is ephemeral unless the db file is on a mounted volume; operators may forget to mount it — *Mitigation: Default the SQLite path to /data/orcha.db and document that /data must be a persistent volume; fall back to /tmp with a loud startup warning if /data is not writable*
- **[low]** Entra ID OIDC callback requires a public HTTPS redirect URI; local development setup is cumbersome — *Mitigation: Provide a --auth none flag and a static token fallback; document ngrok or Caddy for local OIDC testing; ship a docker-compose.yml with Caddy sidecar*
- **[medium]** Rewriting from scratch risks losing subtle invariants (e.g. session-worktree consistency, no silent overwrite on register) that were hard-won in the original — *Mitigation: Extract business invariants from the original codebase into a written spec before coding begins; translate them into integration tests in Phase 1*

## Phase Overview
1. **Phase 1 – Foundation: Repo, Toolchain & Core Domain** — 7 milestones
2. **Phase 2 – Terminal Backend: node-pty, Git Worktrees & Session Lifecycle** — 7 milestones
3. **Phase 3 – Web Server: Express + WebSocket + Auth** — 7 milestones
4. **Phase 4 – HTMX Desktop UI: Session Dashboard** — 7 milestones
5. **Phase 5 – Mobile UI: Single-Terminal Page** — 6 milestones
6. **Phase 6 – Container Deployment & Persistence** — 7 milestones
7. **Phase 7 – Hardening, Observability & CLI Compat** — 7 milestones

---

# Phase 1: Phase 1 – Foundation: Repo, Toolchain & Core Domain
**Milestones: 7**

Establish the brand-new repository with all tooling configured, define the core domain model in TypeScript, and implement the SQLite persistence layer. This is the bedrock everything else builds on. Nothing is deployable yet but every subsequent phase depends on these contracts being stable.

## Milestone 1: Initialise repo: TypeScript, ESLint, Prettier, Vitest, tsconfig paths, package.json scripts
Create an empty git repository with a production-grade Node.js/TypeScript toolchain so that every subsequent milestone has a consistent build, lint, format, and test pipeline to verify against.

1. Run `git init orcha && cd orcha` to create the new repository, then run `npm init -y` to generate a base `package.json`.
2. Set `"type": "module"` in `package.json` and pin `"engines": { "node": ">=20.0.0" }`. Write `20` into `.nvmrc`.
3. Install TypeScript and build tooling: `npm install --save-dev typescript tsx tsup @types/node`. Create `tsconfig.json` with `compilerOptions` targeting `ES2022`, `moduleResolution: bundler`, `module: ESNext`, `strict: true`, `exactOptionalPropertyTypes: true`, `noUncheckedIndexedAccess: true`, `outDir: dist`, `rootDir: src`, and a `paths` alias map: `"@orcha/domain": ["src/domain/index.ts"]`, `"@orcha/db": ["src/db/index.ts"]`. Create `tsconfig.build.json` that extends `tsconfig.json` and adds `"exclude": ["src/**/*.test.ts", "src/__tests__"]`.
4. Install ESLint and plugins: `npm install --save-dev eslint @typescript-eslint/eslint-plugin @typescript-eslint/parser eslint-plugin-import`. Create `.eslintrc.cjs` enabling `@typescript-eslint/recommended`, `@typescript-eslint/recommended-requiring-type-checking`, and `import/no-cycle` with `parser: '@typescript-eslint/parser'` and `parserOptions.project: './tsconfig.json'`.
5. Install Prettier: `npm install --save-dev prettier`. Create `.prettierrc` with `{ "singleQuote": true, "trailingComma": "all", "printWidth": 100, "semi": true }`. Create `.prettierignore` listing `dist/`, `node_modules/`, and `*.sql`.
6. Install Vitest: `npm install --save-dev vitest @vitest/coverage-v8`. Create `vitest.config.ts` that imports `defineConfig` from `vitest/config`, sets `test.environment` to `node`, `test.include` to `['src/**/*.test.ts']`, and `resolve.alias` mirroring the TypeScript path aliases.
7. Add scripts to `package.json`: `"build": "tsup src/index.ts --format esm --dts --out-dir dist"`, `"build:check": "tsc -p tsconfig.build.json --noEmit"`, `"lint": "eslint 'src/**/*.ts' --max-warnings 0"`, `"format": "prettier --write 'src/**/*.ts'"`, `"format:check": "prettier --check 'src/**/*.ts'"`, `"test": "vitest run"`, `"test:watch": "vitest"`, `"test:coverage": "vitest run --coverage"`.
8. Create a minimal `src/index.ts` that exports the string constant `export const APP_NAME = 'orcha';` so the build has a real entry point to compile.
9. Create `.gitignore` listing `node_modules/`, `dist/`, `*.db`, `*.db-shm`, `*.db-wal`, `.env`, and `coverage/`.
10. Run `npm install && npm run build && npm run lint && npm run format:check && npm test` and confirm all commands exit 0.

**Key files**: package.json, tsconfig.json, tsconfig.build.json, .eslintrc.cjs, .prettierrc, .prettierignore, .gitignore, vitest.config.ts, .nvmrc

**Verification**:
```bash
npm install && npm run build && npm run lint && npm run format:check && npm test
```

## Milestone 2: Define core domain types: Session, WorktreeInfo, InstanceInfo, SessionStatus, SessionConfig (no pipeline types)
Declare the canonical TypeScript types that every subsequent module in the project will depend on. These types are deliberately free of I/O, frameworks, and pipeline concepts — they are pure domain contracts.

1. Create the directory `src/domain/` and open `src/domain/types.ts`. Define and export the `SessionStatus` string-literal union: `'pending' | 'starting' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'`.
2. In the same file, define and export the `WorktreeInfo` interface with fields: `worktreePath: string`, `branch: string`, `headSha: string`, `repoRoot: string`, `createdAt: Date`.
3. Define and export the `SessionConfig` interface with fields: `instanceId: string`, `repoRoot: string`, `branch: string`, `worktreePath: string`, `prompt: string`, `env: Record<string, string>`, `maxRuntimeSeconds: number`.
4. Define and export the `Session` interface with fields: `id: string` (UUID), `displayId: number` (auto-increment surrogate), `instanceId: string`, `status: SessionStatus`, `config: SessionConfig`, `worktree: WorktreeInfo`, `createdAt: Date`, `updatedAt: Date`, `startedAt: Date | undefined`, `completedAt: Date | undefined`, `exitCode: number | undefined`, `errorMessage: string | undefined`.
5. Define and export the `InstanceInfo` interface with fields: `id: string`, `repoRoot: string`, `registeredAt: Date`, `lastSeenAt: Date`, `activeSessions: number`.
6. Create `src/domain/status-transitions.ts`. Define and export `VALID_TRANSITIONS` as a `ReadonlyMap<SessionStatus, ReadonlySet<SessionStatus>>` with the following allowed edges: `pending → [starting, cancelled]`, `starting → [running, failed, cancelled]`, `running → [paused, completed, failed, cancelled]`, `paused → [running, cancelled]`, `completed → []`, `failed → []`, `cancelled → []`.
7. In `src/domain/status-transitions.ts`, export the function `isValidTransition(from: SessionStatus, to: SessionStatus): boolean` that looks up `from` in `VALID_TRANSITIONS` and checks whether the resulting set contains `to`.
8. Export the function `assertValidTransition(from: SessionStatus, to: SessionStatus): void` that calls `isValidTransition` and throws a `TypeError` with the message `'Invalid status transition: ${from} → ${to}'` if it returns false.
9. Create `src/domain/index.ts` that re-exports everything from `./types.ts` and `./status-transitions.ts` using named `export * from` statements.
10. Create `src/domain/types.test.ts`. Write Vitest tests that: (a) verify `isValidTransition('pending', 'starting')` returns `true`; (b) verify `isValidTransition('completed', 'running')` returns `false`; (c) verify `assertValidTransition('running', 'failed')` does not throw; (d) verify `assertValidTransition('completed', 'running')` throws a `TypeError` whose message includes `'completed → running'`; (e) verify that the `Session` type compiles correctly by constructing a valid object literal and asserting it satisfies the `Session` type using a TypeScript `satisfies` expression inside the test file.
11. Run `npm run build:check && npm test -- src/domain/` and confirm all type checks pass and all tests are green.

**Key files**: src/domain/types.ts, src/domain/index.ts, src/domain/status-transitions.ts, src/domain/types.test.ts

**Verification**:
```bash
npm run build:check && npm test -- src/domain/
```

## Milestone 3: SQLite schema and migration runner: sessions, instances, status_events tables
Introduce the SQLite persistence layer with a versioned migration runner, establishing the `sessions`, `instances`, and `status_events` tables, and expose a single typed database connection that all repositories will share.

1. Install the `better-sqlite3` driver and its types: `npm install better-sqlite3 && npm install --save-dev @types/better-sqlite3`. Because this is a greenfield project targeting Node.js ≥ 20, no native rebuild shim is needed.
2. Create `src/db/connection.ts`. Import `Database` from `better-sqlite3`. Export a function `openDatabase(dataPath: string): Database.Database` that opens (or creates) a SQLite file at `path.join(dataPath, 'orcha.db')`, executes `PRAGMA journal_mode = WAL;`, `PRAGMA foreign_keys = ON;`, and `PRAGMA synchronous = NORMAL;`, then returns the database handle.
3. Export a module-level singleton factory `getDb(): Database.Database` in `src/db/connection.ts` that reads `process.env['DATA_PATH'] ?? '/data'`, calls `openDatabase`, caches the result in a module-level variable, and returns the cached instance on subsequent calls. This prevents multiple open handles in the same process.
4. Create the directory `src/db/migrations/` and write `src/db/migrations/001_initial_schema.sql` with the following SQL: Create table `schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`; create table `instances (id TEXT PRIMARY KEY, repo_root TEXT NOT NULL, registered_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, active_sessions INTEGER NOT NULL DEFAULT 0)`; create table `sessions (id TEXT PRIMARY KEY, display_id INTEGER NOT NULL UNIQUE, instance_id TEXT NOT NULL REFERENCES instances(id), status TEXT NOT NULL, config_json TEXT NOT NULL, worktree_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, exit_code INTEGER, error_message TEXT)`; create index `idx_sessions_instance_id ON sessions(instance_id)`; create index `idx_sessions_status ON sessions(status)`; create table `status_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), from_status TEXT NOT NULL, to_status TEXT NOT NULL, occurred_at TEXT NOT NULL, note TEXT)`; create index `idx_status_events_session_id ON status_events(session_id)`.
5. Create `src/db/migrate.ts`. Export the function `runMigrations(db: Database.Database, migrationsDir: string): void`. Inside, use `db.prepare('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)').run()` to ensure the tracking table exists before any migration runs.
6. In `runMigrations`, read all `*.sql` files from `migrationsDir` using `fs.readdirSync`, sort them lexicographically, and for each file parse the version number from the filename prefix (e.g. `001` from `001_initial_schema.sql`). Check whether `db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(version)` returns a row; if not, read the file with `fs.readFileSync`, execute its content via `db.exec(sql)`, then insert a row into `schema_migrations` with the version and the current ISO timestamp, all inside a single `db.transaction(...)` call so a failed migration leaves the database unchanged.
7. Create `src/db/index.ts` that exports `openDatabase` and `getDb` from `./connection.ts` and `runMigrations` from `./migrate.ts`.
8. Create `src/db/migrate.test.ts`. In `beforeEach`, call `openDatabase(':memory:')` (better-sqlite3 accepts the special string `:memory:`) and assign it to a local `db` variable. Write tests that: (a) call `runMigrations(db, 'src/db/migrations')` and assert it does not throw; (b) call it a second time and assert it is idempotent (no error, row count in `schema_migrations` unchanged); (c) query `SELECT name FROM sqlite_master WHERE type='table'` and assert the result contains `instances`, `sessions`, and `status_events`; (d) query `schema_migrations` and assert exactly one row exists with `version = 1`.
9. Run `npm run build:check && npm test -- src/db/` and confirm all tests pass.

**Key files**: src/db/connection.ts, src/db/migrations/001_initial_schema.sql, src/db/migrate.ts, src/db/index.ts, src/db/migrate.test.ts

**Verification**:
```bash
npm run build:check && npm test -- src/db/
```

## Milestone 4: Instance registry backed by SQLite: listInstances, getInstance, registerInstance, unregisterInstance with no-overwrite guard
Implement the InstanceRegistry service with listInstances, getInstance, registerInstance, and unregisterInstance operations, with a no-overwrite guard on register, all persisted to the SQLite instances table.

1. Create `src/db/instance-registry.ts`. Import `Database` from `better-sqlite3`, and import `InstanceInfo` from `@orcha/domain`.
2. Define and export the class `InstanceRegistry` whose constructor accepts `db: Database.Database` and stores it as `this.#db` (private class field).
3. Add a private helper method `#rowToInstanceInfo(row: Record<string, unknown>): InstanceInfo` that maps `row.id` → `id`, `row.repo_root` → `repoRoot`, `new Date(row.registered_at as string)` → `registeredAt`, `new Date(row.last_seen_at as string)` → `lastSeenAt`, `row.active_sessions` → `activeSessions`. Use explicit type assertions on each field.
4. Implement `listInstances(): InstanceInfo[]` by preparing `SELECT * FROM instances ORDER BY registered_at ASC`, calling `.all()`, and mapping each row through `#rowToInstanceInfo`.
5. Implement `getInstance(id: string): InstanceInfo | undefined` by preparing `SELECT * FROM instances WHERE id = ?`, calling `.get(id)`, and returning `#rowToInstanceInfo(row)` if a row is found, else `undefined`.
6. Implement `registerInstance(info: Omit<InstanceInfo, 'activeSessions'>): InstanceInfo` with a no-overwrite guard: first call `getInstance(info.id)` and if a row already exists throw a `TypeError` with the message `'Instance already registered: ${info.id}'`. Otherwise prepare `INSERT INTO instances (id, repo_root, registered_at, last_seen_at, active_sessions) VALUES (?, ?, ?, ?, 0)` and run it with the appropriate mapped values, storing ISO strings for date fields. Return `getInstance(info.id)!`.
7. Implement `unregisterInstance(id: string): void` that first calls `getInstance(id)` and throws a `TypeError` with message `'Instance not found: ${id}'` if absent, then prepares `DELETE FROM instances WHERE id = ?` and runs it.
8. Implement `updateLastSeen(id: string): void` that prepares `UPDATE instances SET last_seen_at = ? WHERE id = ?` with `new Date().toISOString()` and runs it.
9. Create `src/db/instance-registry.test.ts`. In `beforeEach`, open an in-memory database with `openDatabase(':memory:')`, run `runMigrations(db, 'src/db/migrations')`, and construct a fresh `InstanceRegistry(db)`. Write tests that: (a) `listInstances` returns an empty array on a fresh database; (b) `registerInstance` with a valid `Omit<InstanceInfo, 'activeSessions'>` payload returns an `InstanceInfo` with `activeSessions === 0` and ISO-parseable date fields; (c) `listInstances` after one registration returns exactly one item; (d) calling `registerInstance` again with the same `id` throws a `TypeError` whose message includes the id (no-overwrite guard); (e) `getInstance` with a registered id returns the correct object; (f) `getInstance` with an unknown id returns `undefined`; (g) `unregisterInstance` with a registered id removes the row so `getInstance` returns `undefined`; (h) `unregisterInstance` with an unknown id throws a `TypeError`.
10. Run `npm run build:check && npm test -- src/db/instance-registry` and confirm all tests pass.

**Key files**: src/db/instance-registry.ts, src/db/instance-registry.test.ts

**Verification**:
```bash
npm run build:check && npm test -- src/db/instance-registry
```

## Milestone 5: Session store backed by SQLite: create, read, update, delete session metadata with atomic writes
Implement the SessionStore service providing create, read, update, delete, and list operations for Session metadata, with status-transition validation enforced on every update and all multi-step mutations wrapped in SQLite transactions.

1. Create `src/db/session-store.ts`. Import `Database` from `better-sqlite3`, and import `Session`, `SessionStatus`, `SessionConfig`, `WorktreeInfo`, `assertValidTransition` from `@orcha/domain`.
2. Define and export the class `SessionStore` whose constructor accepts `db: Database.Database` and assigns it to `this.#db`.
3. Add a private helper `#rowToSession(row: Record<string, unknown>): Session` that deserialises each column: `id`, `display_id` → `displayId`, `instance_id` → `instanceId`, `status` cast to `SessionStatus`, `JSON.parse(row.config_json as string)` → `config`, `JSON.parse(row.worktree_json as string)` → `worktree`, and optional ISO-to-Date conversions for `created_at`, `updated_at`, `started_at`, `completed_at`, `exit_code`, `error_message`.
4. Implement `createSession(config: SessionConfig, worktree: WorktreeInfo): Session` wrapped in a `this.#db.transaction(...)` call. Inside the transaction: (a) query `SELECT COALESCE(MAX(display_id), 0) + 1 AS next FROM sessions` to compute the next `displayId`; (b) generate a UUID using `crypto.randomUUID()` (Node built-in, no library needed); (c) prepare and run `INSERT INTO sessions (id, display_id, instance_id, status, config_json, worktree_json, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)` with ISO timestamps for `created_at` and `updated_at`; (d) return `getSession(id)!` from within the transaction.
5. Implement `getSession(id: string): Session | undefined` using `SELECT * FROM sessions WHERE id = ?` mapped through `#rowToSession`.
6. Implement `getSessionByDisplayId(displayId: number): Session | undefined` using `SELECT * FROM sessions WHERE display_id = ?`.
7. Implement `listSessions(instanceId?: string): Session[]` that, when `instanceId` is provided, uses `SELECT * FROM sessions WHERE instance_id = ? ORDER BY display_id ASC`, otherwise uses `SELECT * FROM sessions ORDER BY display_id ASC`.
8. Implement `updateStatus(id: string, to: SessionStatus, note?: string): Session` wrapped in a `this.#db.transaction(...)`. Inside: (a) call `getSession(id)` and throw `TypeError('Session not found: ' + id)` if absent; (b) call `assertValidTransition(session.status, to)` which will throw on invalid transitions; (c) build a `SET` clause object with `status = to` and `updated_at = now`; also set `started_at` when `to === 'running'` and `completed_at` when `to` is `'completed'`, `'failed'`, or `'cancelled'`; (d) run the UPDATE; (e) insert a row into `status_events (session_id, from_status, to_status, occurred_at, note)` using the pre-transition status and the new status; (f) return `getSession(id)!`.
9. Implement `updateSession(id: string, patch: { errorMessage?: string; exitCode?: number }): Session` wrapped in a transaction that verifies the session exists, then runs `UPDATE sessions SET error_message = ?, exit_code = ?, updated_at = ? WHERE id = ?` and returns the updated session.
10. Implement `deleteSession(id: string): void` that verifies the session exists (throwing `TypeError` if not), then within a transaction deletes from `status_events WHERE session_id = ?` first, then `DELETE FROM sessions WHERE id = ?` to respect the foreign-key constraint.
11. Create `src/db/session-store.test.ts`. Set up in-memory db and `SessionStore` in `beforeEach`. Write tests that: (a) `createSession` returns a `Session` with `status === 'pending'` and sequential `displayId` values; (b) `getSession` returns the created session; (c) `getSessionByDisplayId` returns the same session by display id; (d) `listSessions` without filter returns all sessions; (e) `listSessions` with `instanceId` filter returns only matching sessions; (f) `updateStatus('pending', 'running')` succeeds and sets `startedAt`; (g) `updateStatus` with an invalid transition (e.g. `'pending' → 'completed'`) throws a `TypeError`; (h) `updateStatus` on a non-existent id throws `TypeError('Session not found: ...')`; (i) after `updateStatus` to a terminal state, `status_events` table contains a row with correct `from_status` and `to_status`; (j) `deleteSession` removes the session and its status events; (k) concurrent `createSession` calls (simulated by running two calls in a loop) produce unique `displayId` values.
12. Run `npm run build:check && npm test -- src/db/session-store` and confirm all tests pass.

**Key files**: src/db/session-store.ts, src/db/session-store.test.ts

**Verification**:
```bash
npm run build:check && npm test -- src/db/session-store
```

## Milestone 6: Business invariant test suite: session-worktree consistency, no silent overwrite, valid status transitions
Write a dedicated integration test file that exercises cross-service business rules — rules that span both the InstanceRegistry and SessionStore — ensuring the domain invariants hold as a cohesive system rather than in isolation.

1. Create `src/db/invariants.test.ts`. Add imports for `openDatabase` and `runMigrations` from `@orcha/db`, and `InstanceRegistry` and `SessionStore` from their respective module paths. Add a Vitest `describe` block titled `'Business invariants'`.
2. In `beforeEach`, open a fresh in-memory database, run migrations, and construct both `registry = new InstanceRegistry(db)` and `store = new SessionStore(db)` so each test gets a clean slate.
3. Write test `'Session must reference a registered instance (FK enforcement)'`: call `store.createSession` with a `config` whose `instanceId` is a random UUID that has never been registered, and assert that the call throws (SQLite foreign-key violation). This validates that `PRAGMA foreign_keys = ON` is active.
4. Write test `'Session worktree path must be consistent with config worktreePath'`: register an instance, create a session, retrieve it with `getSession`, and assert that `session.worktree.worktreePath === session.config.worktreePath`. This is a schema-level consistency invariant that the `createSession` method must preserve.
5. Write test `'No-overwrite guard: registering the same instance twice throws'`: register an instance successfully, then call `registerInstance` again with the same `id` and a different `repoRoot`, and assert a `TypeError` is thrown with a message that includes the instance id. Assert that `listInstances()` still returns exactly one instance (the original), confirming the first registration was not mutated.
6. Write test `'Full status lifecycle: pending → starting → running → completed'`: register an instance, create a session, then call `updateStatus` in sequence through `starting`, `running`, `completed`, asserting the returned status at each step, and assert `startedAt` is defined after the `running` transition and `completedAt` is defined after `completed`.
7. Write test `'Invalid status transition is rejected and leaves status unchanged'`: create a session in `pending` status, attempt `updateStatus(id, 'completed')` and catch the expected `TypeError`, then call `getSession(id)` and assert `status === 'pending'` to confirm the rejected transition did not partially mutate state.
8. Write test `'Terminal status is final: no further transitions from completed'`: drive a session to `completed`, then attempt each remaining status value (`pending`, `starting`, `running`, `paused`, `failed`, `cancelled`) in a loop and assert each call throws `TypeError`. Assert `getSession(id)?.status === 'completed'` after all failed attempts.
9. Write test `'Status events are recorded for every valid transition'`: drive a session through `pending → starting → running → failed`, then query `status_events WHERE session_id = ?` directly on the database and assert exactly three rows exist with `from_status` / `to_status` pairs matching `pending/starting`, `starting/running`, `running/failed`.
10. Write test `'deleteSession removes session and all its status events'`: create a session, drive it to `running`, call `deleteSession`, then assert `getSession(id)` returns `undefined` and a direct query on `status_events WHERE session_id = ?` returns zero rows.
11. Run `npm run build:check && npm test -- src/db/invariants` and confirm all eight tests pass.

**Key files**: src/db/invariants.test.ts

**Verification**:
```bash
npm run build:check && npm test -- src/db/invariants
```

## Milestone 7: Dockerfile (Debian-slim, node-pty build deps) and docker-compose.yml with /data volume and Caddy sidecar
Produce a working Dockerfile that installs all native build dependencies for node-pty (needed in Phase 2), creates the /data volume mount point, and runs the Node.js process, paired with a docker-compose.yml that wires up the Caddy reverse-proxy sidecar and a named volume for durable SQLite storage.

1. Create `.dockerignore` listing `node_modules/`, `dist/`, `*.db`, `*.db-shm`, `*.db-wal`, `.env`, `coverage/`, `.git/`, and `*.test.ts` to keep the build context small.
2. Create `Dockerfile`. Start with `FROM node:20-slim AS base`. Install system packages required for node-pty native compilation in a single `RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git && rm -rf /var/lib/apt/lists/*`. Also install `blobfuse2` runtime dependency placeholder comment so Phase 6 can uncomment it: add a commented-out line `# RUN apt-get install -y blobfuse2`.
3. In the `Dockerfile`, set `WORKDIR /app` and copy `package.json package-lock.json ./` then run `npm ci --omit=dev` (production deps only for the final image; native deps compile here). Copy the compiled output: `COPY dist/ dist/`.
4. Add a multi-stage build: label the first stage `AS builder`, add `FROM base AS builder`, copy full source including `tsconfig*.json`, run `npm ci` (with devDependencies), then `npm run build`. Then define `FROM base AS runtime`, copy `--from=builder /app/dist ./dist`, copy `--from=builder /app/node_modules ./node_modules`.
5. In the `runtime` stage, create the data directory: `RUN mkdir -p /data && chown node:node /data`. Switch to the non-root user: `USER node`. Set `ENV DATA_PATH=/data` and `ENV NODE_ENV=production`. Declare `VOLUME ["/data"]`. Set `EXPOSE 3000`. Write `CMD ["node", "dist/index.js"]`.
6. Create `Caddyfile` with a single-site block: `{$PUBLIC_HOST:localhost}` as the address, a `reverse_proxy` directive pointing to `orcha:3000`, and a `tls internal` directive (self-signed for local compose; in Phase 6 this will become Let's Encrypt). Add a comment noting that `PUBLIC_HOST` must be overridden in production.
7. Create `docker-compose.yml` using `version: '3.9'`. Define two services: `orcha` built from `.` with `build: { context: ., dockerfile: Dockerfile, target: runtime }`, `volumes: [orcha_data:/data]`, `environment: [DATA_PATH=/data, NODE_ENV=production]`, `restart: unless-stopped`, and `networks: [internal]`. Define `caddy` using `image: caddy:2-alpine`, `ports: ["80:80", "443:443"]`, `volumes: [./Caddyfile:/etc/caddy/Caddyfile:ro, caddy_data:/data, caddy_config:/config]`, `depends_on: [orcha]`, `networks: [internal]`, `restart: unless-stopped`.
8. In `docker-compose.yml`, declare named volumes: `orcha_data: {}`, `caddy_data: {}`, `caddy_config: {}`, and a network `internal: { driver: bridge }`.
9. Run `docker build -t orcha:phase1 .` and confirm the image builds without errors (the `dist/index.js` from the previous milestones will be copied correctly since `npm run build` emits it).
10. Run `docker compose config --quiet` and confirm docker-compose parses the file without validation errors. Optionally run `docker compose up -d` and confirm both containers start, then `docker compose down`.

**Key files**: Dockerfile, docker-compose.yml, Caddyfile, .dockerignore

**Verification**:
```bash
docker build -t orcha:phase1 . && docker compose config --quiet
```

---

# Phase 2: Phase 2 – Terminal Backend: node-pty, Git Worktrees & Session Lifecycle
**Milestones: 7**

Implement the server-side session engine — creating git worktrees, spawning node-pty PTY processes, and managing the full session lifecycle. This replaces both tmux-renderer and worktree-manager with a PTY-first design. Verifiable by running sessions from a test harness before any UI exists.

## Milestone 1: WorktreeManager: git worktree add/remove/list with branch sanitisation and injection guards
Implement a self-contained WorktreeManager class that shells out to git for worktree operations, sanitises branch names, and prevents command injection. This is the foundation that SessionManager will orchestrate.

1. Create the directory `src/terminal/` — this is the new home for all Phase 2 modules, deliberately separate from the legacy `src/core/` to avoid contaminating the old codebase during the greenfield build.
2. Create `src/terminal/worktree-manager.ts`. Define and export the interface `WorktreeInfo { id: string; path: string; branch: string; commitSha: string; createdAt: Date }` and the interface `WorktreeManagerOptions { repoRoot: string; worktreesBaseDir: string }`.
3. In `src/terminal/worktree-manager.ts`, implement the exported class `WorktreeManager` with a constructor that accepts `WorktreeManagerOptions` and stores them as private readonly fields.
4. Add a private static method `sanitiseBranchName(raw: string): string` that (a) strips any leading/trailing whitespace, (b) replaces characters not matching `[a-zA-Z0-9._/-]` with `-`, (c) collapses consecutive hyphens into one, (d) strips leading dots (git disallows them), and (e) truncates to 100 characters. Throw a `WorktreeError` with code `INVALID_BRANCH` if the result is empty after sanitisation.
5. Add a private static method `assertNoInjection(value: string, field: string): void` that throws `WorktreeError` with code `INJECTION_ATTEMPT` if `value` contains any of: `, backtick, `|`, `;`, `&`, `>`, `<`, `(`, `)`, `\n`, `\r`. This guard is applied to every value passed to child processes.
6. Add a private async helper `execGit(args: string[]): Promise<string>` that uses `node:child_process` `execFile` (not `exec`) with the `git` binary and the provided args array, sets `cwd` to `this.options.repoRoot`, captures stdout, and rejects with a `WorktreeError` (code `GIT_ERROR`, message includes stderr) on non-zero exit.
7. Implement `async addWorktree(sessionId: string, branch: string): Promise<WorktreeInfo>`. Call `assertNoInjection(sessionId, 'sessionId')`, call `sanitiseBranchName(branch)` to get `safeBranch`, compute `worktreePath` as `path.join(this.options.worktreesBaseDir, sessionId)`, then call `execGit(['worktree', 'add', '-b', safeBranch, worktreePath])`. After success, call `execGit(['rev-parse', 'HEAD'])` with `cwd` overridden to `worktreePath` to get `commitSha`. Return a `WorktreeInfo` object.
8. Implement `async removeWorktree(sessionId: string): Promise<void>`. Call `assertNoInjection(sessionId, 'sessionId')`, compute `worktreePath`, call `execGit(['worktree', 'remove', '--force', worktreePath])`, then call `execGit(['worktree', 'prune'])` to clean up stale refs.
9. Implement `async listWorktrees(): Promise<WorktreeInfo[]>`. Call `execGit(['worktree', 'list', '--porcelain'])` and parse the porcelain output: each block is separated by a blank line and has lines `worktree <path>`, `HEAD <sha>`, `branch refs/heads/<branch>`. Map blocks to `WorktreeInfo` objects, filtering out the main worktree (the first block in `git worktree list --porcelain` always represents the main worktree, identifiable by comparing its path to `this.options.repoRoot`).
10. Implement `async worktreeExists(sessionId: string): Promise<boolean>` that calls `listWorktrees()` and checks if any entry's path ends with the sessionId segment.
11. Define and export class `WorktreeError extends Error` with fields `code: 'INVALID_BRANCH' | 'INJECTION_ATTEMPT' | 'GIT_ERROR' | 'NOT_FOUND'` and `originalError?: unknown`.
12. Create `src/terminal/worktree-manager.test.ts`. Import `WorktreeManager` and `WorktreeError`. Write tests using `vitest` that: (a) mock `child_process.execFile` using `vi.mock('node:child_process')` to simulate successful `git worktree add` and verify the returned `WorktreeInfo` shape; (b) verify `sanitiseBranchName` strips forbidden characters from a crafted input string `'feat/my session!@#'` to produce `'feat/my-session---'` (or equivalent safe form); (c) verify `assertNoInjection` throws `WorktreeError` with code `INJECTION_ATTEMPT` when a value contains `$(`; (d) verify `removeWorktree` calls `execFile` with `['worktree', 'remove', '--force', ...]` then `['worktree', 'prune']` in sequence; (e) verify `listWorktrees` correctly parses porcelain output with two worktree blocks.
13. Create `src/terminal/index.ts` and export `WorktreeManager`, `WorktreeError`, and `WorktreeInfo` from `'./worktree-manager.js'`.

**Key files**: src/terminal/worktree-manager.ts, src/terminal/worktree-manager.test.ts, src/terminal/index.ts

**Verification**:
```bash
npm run build && npm run test -- src/terminal/worktree-manager.test.ts --reporter=verbose
```

## Milestone 2: PtyManager: spawn node-pty sessions, resize, write input, read output stream, kill — abstracted behind a SessionTerminal interface
Wrap node-pty in a typed SessionTerminal abstraction that emits output as a Node.js Readable stream, supports resize and keyboard input, and exposes a clean kill/exit lifecycle. Consumers never import node-pty directly.

1. Confirm `node-pty` is listed in `package.json` dependencies (add it if not present: `npm install node-pty` and `npm install --save-dev @types/node-pty`). Confirm the `node-pty` native addon compiles successfully by running `npm rebuild node-pty`.
2. Create `src/terminal/session-terminal.ts`. Define and export the interface `TerminalSize { cols: number; rows: number }`. Define and export the interface `SessionTerminal` with methods: `readonly sessionId: string`, `readonly pid: number | undefined`, `readonly exitCode: number | undefined`, `write(data: string): void`, `resize(size: TerminalSize): void`, `kill(signal?: string): void`, `readonly output: NodeJS.ReadableStream`, and event emitter methods `on(event: 'exit', listener: (code: number, signal: string) => void): this` and `on(event: 'error', listener: (err: Error) => void): this`. Also export the type `PtySpawnOptions { sessionId: string; cwd: string; command: string; args?: string[]; env?: Record<string, string>; size?: TerminalSize }`.
3. Create `src/terminal/pty-manager.ts`. Import `IPty` and `spawn` from `node-pty`. Import `Readable` from `node:stream`. Import `EventEmitter` from `node:events`.
4. Define the private class `PtySessionTerminal extends EventEmitter implements SessionTerminal`. Its constructor accepts `sessionId: string` and `pty: IPty`. Store both as private readonly fields. Set `this._exitCode = undefined`.
5. In `PtySessionTerminal`, implement `get pid(): number | undefined` returning `this._pty.pid`.
6. Implement `get exitCode(): number | undefined` returning `this._exitCode`.
7. Implement `get output(): NodeJS.ReadableStream`. On first access, create a `Readable` with `read() {}` (push-based). Attach a one-time setup that calls `this._pty.onData((data) => { if (!readable.push(data)) { /* backpressure: no-op for now, PTY is push-only */ } })`. Store the readable as `_outputStream` and return it on subsequent calls.
8. Implement `write(data: string): void` that calls `this._pty.write(data)`, guarded by a check that `this._exitCode === undefined` to prevent writes to a dead PTY.
9. Implement `resize(size: TerminalSize): void` that validates `size.cols >= 1 && size.rows >= 1` (clamp to min 1 if not) then calls `this._pty.resize(size.cols, size.rows)`.
10. Implement `kill(signal: string = 'SIGTERM'): void` that calls `this._pty.kill(signal)`.
11. In the `PtySessionTerminal` constructor, attach `this._pty.onExit(({ exitCode, signal }) => { this._exitCode = exitCode; this._outputStream?.push(null); this.emit('exit', exitCode, signal ?? ''); })` to handle PTY exit and close the readable stream.
12. Export the class `PtyManager`. Give it a private `Map<string, PtySessionTerminal>` named `_sessions`. Implement `spawn(opts: PtySpawnOptions): SessionTerminal`. Inside, verify no session with `opts.sessionId` already exists (throw `PtyError` with code `ALREADY_EXISTS` if so), call `node-pty spawn(opts.command, opts.args ?? [], { name: 'xterm-256color', cols: opts.size?.cols ?? 80, rows: opts.size?.rows ?? 24, cwd: opts.cwd, env: { ...process.env, ...opts.env } })`, construct a `PtySessionTerminal`, register a listener on its `'exit'` event to call `this._sessions.delete(opts.sessionId)`, store in `_sessions`, and return it.
13. Implement `get(sessionId: string): SessionTerminal | undefined` returning `this._sessions.get(sessionId)`.
14. Implement `async killAll(signal: string = 'SIGTERM'): Promise<void>` that iterates `_sessions.values()` and calls `.kill(signal)` on each, then waits 2000ms for them to exit naturally before returning.
15. Define and export `class PtyError extends Error` with field `code: 'ALREADY_EXISTS' | 'SPAWN_FAILED' | 'NOT_FOUND'`.
16. Create `src/terminal/pty-manager.test.ts`. Because node-pty spawns real OS processes, mock `node-pty` with `vi.mock('node-pty')` and provide a fake `IPty` implementation with `onData`, `onExit`, `write`, `resize`, `kill`, and `pid` fields. Test: (a) `spawn` returns a `SessionTerminal` whose `pid` matches the mock; (b) data emitted from the mock PTY's `onData` callback appears on the `output` Readable stream; (c) `resize` clamps cols/rows to a minimum of 1; (d) `write` is a no-op after the PTY has exited (i.e. after the mock fires `onExit`); (e) `spawn` throws `PtyError` with code `ALREADY_EXISTS` when called twice with the same `sessionId`; (f) `killAll` calls `kill` on every active session.
17. Export `PtyManager`, `PtyError`, `SessionTerminal`, `PtySpawnOptions`, and `TerminalSize` from `src/terminal/index.ts`.

**Key files**: src/terminal/session-terminal.ts, src/terminal/pty-manager.ts, src/terminal/pty-manager.test.ts, src/terminal/index.ts, package.json

**Verification**:
```bash
npm run build && npm run test -- src/terminal/pty-manager.test.ts --reporter=verbose
```

## Milestone 3: SessionManager: orchestrate WorktreeManager + PtyManager, enforce session-worktree-PTY triple invariant
Implement the SessionManager that creates/stops/queries sessions, ensuring that every live session always has exactly one worktree and one PTY process. Persists session records to SQLite via the repository layer established in Phase 1.

1. Create `src/terminal/output-buffer.ts`. Export the class `OutputBuffer` with constructor `(maxBytes: number = 512 * 1024)`. Internally maintain a `Buffer[]` array `_chunks` and a `_totalBytes: number` counter. Implement `push(chunk: Buffer | string): void` that converts strings to `Buffer`, appends to `_chunks`, increments `_totalBytes`, and evicts the oldest chunks from the front while `_totalBytes > maxBytes`. Implement `snapshot(): Buffer` returning `Buffer.concat(this._chunks)`. Implement `clear(): void`. This is the PTY output scrollback used by xterm.js reconnect in Phase 3.
2. Create `src/terminal/session-manager.ts`. Import `WorktreeManager`, `WorktreeInfo`, `WorktreeError` from `'./worktree-manager.js'`. Import `PtyManager`, `SessionTerminal`, `PtySpawnOptions` from `'./pty-manager.js'`. Import `OutputBuffer` from `'./output-buffer.js'`. Import the Phase 1 `SessionRepository` (or equivalent DB access type) from `'../db/index.js'` — use the exact exported name established in Phase 1; if Phase 1 named it differently, use that name and note the import path is `'../db/index.js'`.
3. Define and export the interface `CreateSessionOptions { sessionId?: string; branch: string; command: string; args?: string[]; env?: Record<string, string>; cols?: number; rows?: number }`. Define and export the interface `ActiveSession { sessionId: string; worktree: WorktreeInfo; terminal: SessionTerminal; outputBuffer: OutputBuffer; createdAt: Date }`.
4. Export the class `SessionManager`. Its constructor accepts `(worktreeManager: WorktreeManager, ptyManager: PtyManager, sessionRepo: SessionRepository)` and stores all three as private readonly fields. Maintain a private `Map<string, ActiveSession>` named `_active`.
5. Implement `async createSession(opts: CreateSessionOptions): Promise<ActiveSession>`. Steps: (a) generate `sessionId` as `opts.sessionId ?? crypto.randomUUID()`; (b) verify no key `sessionId` in `_active` (throw `SessionError` code `DUPLICATE_SESSION` if so); (c) call `await this._worktreeManager.addWorktree(sessionId, opts.branch)` — if this throws, rethrow wrapped in `SessionError` code `WORKTREE_FAILED`; (d) call `this._ptyManager.spawn({ sessionId, cwd: worktree.path, command: opts.command, args: opts.args, env: opts.env, size: { cols: opts.cols ?? 220, rows: opts.rows ?? 50 } })` — if this throws, call `await this._worktreeManager.removeWorktree(sessionId)` as rollback then rethrow as `SessionError` code `PTY_FAILED`; (e) create `const buffer = new OutputBuffer()`; (f) pipe terminal output into buffer: `terminal.output.on('data', (chunk) => buffer.push(chunk))`; (g) construct `ActiveSession` and store in `_active`; (h) call `await this._sessionRepo.upsert({ id: sessionId, branch: worktree.branch, worktreePath: worktree.path, pid: terminal.pid, status: 'running', createdAt: new Date() })`; (i) attach `terminal.on('exit', (code) => this._handleExit(sessionId, code))` to clean up on PTY death; (j) return the `ActiveSession`.
6. Implement `private async _handleExit(sessionId: string, exitCode: number): Promise<void>`. Remove `sessionId` from `_active`. Call `await this._sessionRepo.update(sessionId, { status: exitCode === 0 ? 'stopped' : 'failed', exitCode, stoppedAt: new Date() })`. Do NOT remove the worktree automatically — that is the CleanupService's responsibility (M2.5).
7. Implement `async stopSession(sessionId: string): Promise<void>`. Look up in `_active`, throw `SessionError` code `NOT_FOUND` if absent. Call `terminal.kill('SIGTERM')`. Await a promise that resolves on the terminal's `'exit'` event or rejects after a 5000ms timeout, after which call `terminal.kill('SIGKILL')` as a fallback.
8. Implement `getSession(sessionId: string): ActiveSession | undefined` returning `_active.get(sessionId)`.
9. Implement `listSessions(): ActiveSession[]` returning `Array.from(_active.values())`.
10. Implement `getOutputSnapshot(sessionId: string): Buffer`. Look up in `_active`, throw `SessionError` code `NOT_FOUND` if absent. Return `session.outputBuffer.snapshot()`.
11. Define and export `class SessionError extends Error` with field `code: 'DUPLICATE_SESSION' | 'WORKTREE_FAILED' | 'PTY_FAILED' | 'NOT_FOUND' | 'STOP_TIMEOUT'` and `cause?: unknown`.
12. Create `src/terminal/session-manager.test.ts`. Mock both `WorktreeManager` and `PtyManager` using `vi.fn()` constructors that return jest-spy objects. Also mock `SessionRepository` with an object whose `upsert` and `update` methods are `vi.fn()` returning `Promise.resolve()`. Write tests: (a) `createSession` calls `worktreeManager.addWorktree` then `ptyManager.spawn` and returns an `ActiveSession` with matching `sessionId`; (b) if `worktreeManager.addWorktree` throws, `createSession` rethrows `SessionError` with code `WORKTREE_FAILED` and does NOT call `ptyManager.spawn`; (c) if `ptyManager.spawn` throws, `createSession` calls `worktreeManager.removeWorktree` as rollback and rethrows `SessionError` with code `PTY_FAILED`; (d) `stopSession` calls `terminal.kill('SIGTERM')` and the session is removed from `listSessions()` after the mock terminal fires its `'exit'` event; (e) `createSession` twice with the same `sessionId` throws `SessionError` with code `DUPLICATE_SESSION`; (f) `getOutputSnapshot` returns the accumulated buffer contents after simulated PTY data events; (g) `sessionRepo.upsert` is called with `status: 'running'` on create and `sessionRepo.update` is called with `status: 'stopped'` after exit.
13. Export `SessionManager`, `SessionError`, `ActiveSession`, `CreateSessionOptions`, and `OutputBuffer` from `src/terminal/index.ts`.

**Key files**: src/terminal/session-manager.ts, src/terminal/session-manager.test.ts, src/terminal/output-buffer.ts, src/terminal/index.ts

**Verification**:
```bash
npm run build && npm run test -- src/terminal/session-manager.test.ts --reporter=verbose
```

## Milestone 4: StatusMonitor: EventEmitter broadcasting status-change and needs-input events from PTY output heuristics (idle detection, Claude state parsing)
Parse PTY output streams for Claude-specific patterns (idle prompt, tool use, waiting for input) and broadcast typed events via EventEmitter so the dashboard can show real-time session status without polling.

1. Create `src/terminal/claude-patterns.ts`. Export the constant `CLAUDE_PATTERNS` as a `const` object (not an enum, to keep it tree-shakeable) with these string-keyed regex entries: `IDLE_PROMPT: /^\s*>\s*$/m` (bare `>` prompt indicating Claude is waiting for input), `TOOL_USE: /^\s*●\s+\w/m` (Claude's tool-use bullet prefix), `THINKING: /Thinking\.\.\./i`, `TASK_COMPLETE: /Task complete/i`, `ERROR_FATAL: /(?:Error:|error:|ENOENT|EPERM|fatal:)/m`, `NEEDS_CONFIRMATION: /\?\s*\[y\/n\]/i` (yes/no prompts that require user response). Also export the type `PatternKey = keyof typeof CLAUDE_PATTERNS`.
2. Create `src/terminal/status-monitor.ts`. Import `EventEmitter` from `node:events`. Import `CLAUDE_PATTERNS` from `'./claude-patterns.js'`. Import `SessionTerminal` from `'./session-terminal.js'`.
3. Define and export the discriminated union type `StatusEvent` with variants: `{ type: 'status-change'; sessionId: string; status: SessionStatus; prevStatus: SessionStatus; timestamp: Date }` and `{ type: 'needs-input'; sessionId: string; prompt: string; timestamp: Date }`.
4. Export the type `SessionStatus = 'running' | 'idle' | 'thinking' | 'tool-use' | 'needs-input' | 'complete' | 'error'`.
5. Export the class `StatusMonitor extends EventEmitter`. Its constructor accepts `(idleTimeoutMs: number = 10_000)` and stores it. Maintain a private `Map<string, { status: SessionStatus; lastOutputAt: number; idleTimer: NodeJS.Timeout | undefined }>` named `_sessions`.
6. Implement `watch(sessionId: string, terminal: SessionTerminal): void`. If the sessionId is already tracked, return early. Register an entry in `_sessions` with initial `status: 'running'`. Attach a listener on `terminal.output` `'data'` event that calls the private `_processChunk(sessionId, chunk.toString('utf8'))` method. Attach a listener on `terminal` `'exit'` event that calls `_setStatus(sessionId, 'complete')` if `exitCode === 0`, or `_setStatus(sessionId, 'error')` otherwise, then calls `unwatch(sessionId)`.
7. Implement `unwatch(sessionId: string): void`. Retrieve the entry from `_sessions`, clear its `idleTimer` if set, delete the entry.
8. Implement `private _processChunk(sessionId: string, text: string): void`. First update `lastOutputAt` to `Date.now()` and reset the idle timer (clear existing, set new `setTimeout(() => this._setStatus(sessionId, 'idle'), this._idleTimeoutMs)`). Then run pattern matching in priority order: if `CLAUDE_PATTERNS.NEEDS_CONFIRMATION.test(text)`, call `_setStatus(sessionId, 'needs-input')` and also `this.emit('needs-input', { type: 'needs-input', sessionId, prompt: text.slice(0, 200), timestamp: new Date() })`; else if `CLAUDE_PATTERNS.ERROR_FATAL.test(text)`, call `_setStatus(sessionId, 'error')`; else if `CLAUDE_PATTERNS.TASK_COMPLETE.test(text)`, call `_setStatus(sessionId, 'complete')`; else if `CLAUDE_PATTERNS.TOOL_USE.test(text)`, call `_setStatus(sessionId, 'tool-use')`; else if `CLAUDE_PATTERNS.THINKING.test(text)`, call `_setStatus(sessionId, 'thinking')`.
9. Implement `private _setStatus(sessionId: string, next: SessionStatus): void`. Retrieve entry (return if not found). If `next === entry.status`, return (no-op). Set `entry.status = next`. Emit `'status-change'` with payload `{ type: 'status-change', sessionId, status: next, prevStatus: prev, timestamp: new Date() }`.
10. Implement `getStatus(sessionId: string): SessionStatus | undefined` returning `this._sessions.get(sessionId)?.status`.
11. Add TypeScript overloads to `StatusMonitor` for `on(event: 'status-change', listener: (e: StatusEvent & { type: 'status-change' }) => void): this` and `on(event: 'needs-input', listener: (e: StatusEvent & { type: 'needs-input' }) => void): this` to provide type-safe event subscriptions.
12. Create `src/terminal/status-monitor.test.ts`. Construct a `StatusMonitor` with `idleTimeoutMs: 100` for fast timer tests. Mock `SessionTerminal` as an `EventEmitter` subclass with an `output` property that is also an `EventEmitter`. Write tests: (a) emitting a chunk matching `CLAUDE_PATTERNS.TOOL_USE` pattern causes a `status-change` event with `status: 'tool-use'`; (b) emitting a chunk matching `NEEDS_CONFIRMATION` causes both a `status-change` event (`status: 'needs-input'`) and a `needs-input` event with a `prompt` field; (c) after 100ms of no output, `status-change` event fires with `status: 'idle'`; (d) emitting output resets the idle timer (emit output at t=80ms, then at t=150ms confirm no idle event fired at t=100ms but one fires at t=250ms); (e) a terminal `'exit'` event with code `0` produces `status: 'complete'` and removes the session from the monitor; (f) `getStatus` returns `undefined` for an unwatched session.
13. Export `StatusMonitor`, `StatusEvent`, `SessionStatus`, and `CLAUDE_PATTERNS` from `src/terminal/index.ts`.

**Key files**: src/terminal/status-monitor.ts, src/terminal/claude-patterns.ts, src/terminal/status-monitor.test.ts, src/terminal/index.ts

**Verification**:
```bash
npm run build && npm run test -- src/terminal/status-monitor.test.ts --reporter=verbose
```

## Milestone 5: Cleanup service: detect dead PTY processes and orphaned worktrees, unregister stale sessions
Implement a periodic CleanupService that reconciles the live PTY map against the SQLite session records and the filesystem worktree list, removing orphans and updating stale status entries.

1. Create `src/terminal/cleanup-service.ts`. Import `WorktreeManager` from `'./worktree-manager.js'`. Import `SessionManager` from `'./session-manager.js'`. Import the Phase 1 `SessionRepository` from `'../db/index.js'`. Import `EventEmitter` from `node:events`.
2. Define and export the interface `CleanupResult { scannedAt: Date; orphanedWorktreesRemoved: string[]; staleSessionsMarked: string[]; errors: Array<{ sessionId: string; error: string }> }`.
3. Export the class `CleanupService extends EventEmitter`. Its constructor accepts `(sessionManager: SessionManager, worktreeManager: WorktreeManager, sessionRepo: SessionRepository, intervalMs: number = 60_000)`. Store all four as private readonly fields. Initialise `_timer: NodeJS.Timeout | undefined = undefined`.
4. Implement `start(): void`. If `_timer` is already set, return. Call `this._runCleanup()` once immediately (fire-and-forget, errors caught internally). Set `_timer = setInterval(() => this._runCleanup(), this._intervalMs)`.
5. Implement `stop(): void`. If `_timer` is set, call `clearInterval(_timer)` and set `_timer = undefined`.
6. Implement `async runOnce(): Promise<CleanupResult>` — same as `_runCleanup` but public and returns the result, for use in tests and manual operator triggers.
7. Implement `private async _runCleanup(): Promise<void>`. Call `this.runOnce()` internally and emit `'cleanup-complete'` with the result, catching and emitting `'cleanup-error'` on any uncaught rejection.
8. Implement `async runOnce(): Promise<CleanupResult>`. Steps: (a) initialise `result: CleanupResult` with `scannedAt: new Date()` and empty arrays; (b) call `const dbSessions = await this._sessionRepo.listByStatus(['running', 'created'])` to get sessions the DB thinks are live; (c) for each DB session, call `this._sessionManager.getSession(session.id)` — if the result is `undefined` (PTY is not in the active map), the session has died without a clean exit handler firing; mark it: call `await this._sessionRepo.update(session.id, { status: 'failed', stoppedAt: new Date() })` and push `session.id` to `result.staleSessionsMarked`; (d) call `const worktrees = await this._worktreeManager.listWorktrees()` to get all filesystem worktrees; (e) for each `worktree` in `worktrees`, check if any DB session (from a `listAll()` call) has `worktreePath === worktree.path` and `status` in `['running', 'created']` — if none match, it is an orphaned worktree; attempt `await this._worktreeManager.removeWorktree(worktree.id)`, push path to `result.orphanedWorktreesRemoved` on success, or push to `result.errors` on failure; (f) emit `'cleanup-complete'` with `result` and return it.
9. Add TypeScript overloads: `on(event: 'cleanup-complete', listener: (result: CleanupResult) => void): this` and `on(event: 'cleanup-error', listener: (err: Error) => void): this`.
10. Create `src/terminal/cleanup-service.test.ts`. Mock `SessionManager`, `WorktreeManager`, and `SessionRepository` with `vi.fn()` objects. Write tests: (a) `runOnce` marks a DB session as `failed` when `sessionManager.getSession` returns `undefined` for a session that DB says is `running`; (b) `runOnce` calls `worktreeManager.removeWorktree` for a worktree path that has no corresponding active DB session; (c) a `worktreeManager.removeWorktree` failure for an orphan is recorded in `result.errors` and does not prevent processing of remaining orphans; (d) `start` calls `_runCleanup` immediately on the first tick (use `vi.useFakeTimers()` and advance time); (e) `stop` clears the interval so no further cleanup runs fire after it is called; (f) `runOnce` emits `'cleanup-complete'` event with the result object.
11. Export `CleanupService` and `CleanupResult` from `src/terminal/index.ts`.

**Key files**: src/terminal/cleanup-service.ts, src/terminal/cleanup-service.test.ts, src/terminal/index.ts

**Verification**:
```bash
npm run build && npm run test -- src/terminal/cleanup-service.test.ts --reporter=verbose
```

## Milestone 6: Process registry: track child PTY processes for graceful shutdown on SIGTERM
Implement a ProcessRegistry singleton that tracks all active PTY processes and handles SIGTERM/SIGINT by draining them gracefully before the Node.js process exits, preventing orphaned child processes in the container.

1. Create `src/terminal/process-registry.ts`. Import `SessionManager` from `'./session-manager.js'`. Import `CleanupService` from `'./cleanup-service.js'`.
2. Define and export the interface `ShutdownOptions { timeoutMs?: number; runCleanupFirst?: boolean }`.
3. Export the class `ProcessRegistry`. Its constructor is private (enforce singleton via a static factory). Maintain a private `Set<SessionManager>` named `_managers`. Maintain `_shutdownRegistered: boolean = false`.
4. Implement `static getInstance(): ProcessRegistry` — use a module-level `let _instance: ProcessRegistry | undefined` variable, create on first call, return on subsequent calls. This ensures there is exactly one registry per Node.js process.
5. Implement `register(manager: SessionManager): void` that adds `manager` to `_managers`.
6. Implement `unregister(manager: SessionManager): void` that deletes `manager` from `_managers`.
7. Implement `registerShutdownHandlers(cleanup?: CleanupService, opts: ShutdownOptions = {}): void`. Guard with `if (this._shutdownRegistered) return`. Set `this._shutdownRegistered = true`. Call `process.once('SIGTERM', () => this._shutdown(cleanup, opts))`. Call `process.once('SIGINT', () => this._shutdown(cleanup, opts))`.
8. Implement `private async _shutdown(cleanup: CleanupService | undefined, opts: ShutdownOptions): Promise<void>`. Steps: (a) call `cleanup?.stop()` to halt the cleanup interval; (b) if `opts.runCleanupFirst`, await `cleanup?.runOnce()` with a try/catch that logs errors to `process.stderr`; (c) call `await Promise.allSettled(Array.from(this._managers).map(m => m.stopAllSessions()))` where `stopAllSessions` is a method to be added to `SessionManager` (step 9) — use `Promise.allSettled` so one failing manager does not prevent others from shutting down; (d) set a hard `setTimeout(() => process.exit(1), opts.timeoutMs ?? 8000)` with `timer.unref()` so the timer does not keep the event loop alive if everything shuts down cleanly; (e) after all promises settle, call `process.exit(0)`.
9. Return to `src/terminal/session-manager.ts` and add the method `async stopAllSessions(): Promise<void>` that calls `Promise.allSettled(Array.from(this._active.keys()).map(id => this.stopSession(id)))` and awaits it. This is needed by `ProcessRegistry._shutdown`.
10. Create `src/terminal/process-registry.test.ts`. Import `ProcessRegistry`. Because `ProcessRegistry` is a singleton, reset `_instance` between tests by accessing the module-level variable directly via a test-only exported `_resetForTest(): void` function (add this exported function to `process-registry.ts`, guarded by `if (process.env.NODE_ENV === 'test')`). Write tests: (a) `getInstance()` returns the same object on repeated calls; (b) `register` and `unregister` correctly add/remove managers from the internal set; (c) `registerShutdownHandlers` is idempotent — calling it twice does not double-register SIGTERM listeners (verify `process.listenerCount('SIGTERM')` is 1 not 2); (d) simulating shutdown (calling `_shutdown` directly) calls `stopAllSessions` on every registered manager; (e) if `stopAllSessions` rejects on one manager, `_shutdown` still calls `stopAllSessions` on remaining managers (use `Promise.allSettled` behaviour).
11. Export `ProcessRegistry` and `ShutdownOptions` from `src/terminal/index.ts`.

**Key files**: src/terminal/process-registry.ts, src/terminal/process-registry.test.ts, src/terminal/index.ts

**Verification**:
```bash
npm run build && npm run test -- src/terminal/process-registry.test.ts --reporter=verbose
```

## Milestone 7: Integration tests for full session lifecycle: create → running → stop → cleanup
Write end-to-end integration tests that exercise the full session engine stack with real git and real node-pty processes (using `bash` or `sh` as the command under test), verifying the complete create→monitor→stop→cleanup lifecycle without mocks.

1. Update `vitest.config.ts` to add a second test project or `include` glob that matches `src/terminal/__integration__/**/*.test.ts` with `testTimeout: 30000` (30 seconds to allow real git and PTY operations). Keep the existing unit test glob separate so `npm test` without the integration path still runs fast.
2. Create `src/terminal/__integration__/helpers.ts`. Export an async function `makeTestRepo(): Promise<{ repoRoot: string; cleanup: () => Promise<void> }>` that: (a) creates a temp directory using `fs.mkdtemp(path.join(os.tmpdir(), 'orcha-test-'))`, (b) runs `git init` in it via `execFile`, (c) runs `git config user.email 'test@test.com'` and `git config user.name 'Test'` in it, (d) creates a `README.md` file with content `'# test'`, (e) runs `git add .` then `git commit -m 'init'`, (f) creates a `worktrees/` subdirectory alongside it, and (g) returns `repoRoot` and an async `cleanup` function that calls `fs.rm(repoRoot, { recursive: true, force: true })` and `fs.rm(worktreesDir, { recursive: true, force: true })`.
3. Export an async function `makeSqliteRepo(dbPath: string): Promise<SessionRepository>` that creates a SQLite DB at `dbPath` using the Phase 1 `SessionRepository` factory, runs migrations, and returns the instance.
4. Create `src/terminal/__integration__/session-lifecycle.test.ts`. Import `WorktreeManager`, `PtyManager`, `SessionManager`, `StatusMonitor`, `CleanupService` from `'../../terminal/index.js'`. Import helpers from `'./helpers.js'`.
5. Define a `beforeEach` that calls `makeTestRepo()` and `makeSqliteRepo(path.join(tmpDir, 'test.db'))` to create a fresh isolated environment per test, storing results in test-scoped variables. Define an `afterEach` that calls the `cleanup()` function.
6. Write test `'creates a session, worktree appears on filesystem, PTY spawns'`: call `sessionManager.createSession({ branch: 'feat/test-1', command: 'bash', args: ['-c', 'echo hello && sleep 1'] })`. Assert the returned `ActiveSession.sessionId` is a non-empty string. Assert `fs.existsSync(activeSession.worktree.path)` is `true`. Assert `activeSession.terminal.pid` is a positive integer.
7. Write test `'output flows through the buffer'`: create a session with `command: 'bash', args: ['-c', 'echo INTEGRATION_MARKER']`. Wait for the PTY to exit by awaiting a `Promise` that resolves on `terminal.on('exit', ...)`. Call `sessionManager.getOutputSnapshot(sessionId)`. Assert the returned `Buffer.toString('utf8')` contains `'INTEGRATION_MARKER'`.
8. Write test `'stopSession sends SIGTERM, session exits, worktree survives'`: create a session with `command: 'bash', args: ['-c', 'sleep 60']` (long-running process). Assert the session appears in `sessionManager.listSessions()`. Call `await sessionManager.stopSession(sessionId)`. Assert `sessionManager.getSession(sessionId)` is `undefined`. Assert `fs.existsSync(worktreePath)` is still `true` (worktree is not removed on stop).
9. Write test `'StatusMonitor detects idle after PTY exits'`: create `StatusMonitor` with `idleTimeoutMs: 500`. Call `statusMonitor.watch(sessionId, terminal)` with a session whose command is `bash -c 'echo hi'`. Collect status-change events into an array. Await a Promise that resolves 1500ms after session creation. Assert the collected statuses include `'complete'` (because the process exited cleanly with code 0).
10. Write test `'CleanupService removes orphaned worktree'`: manually call `worktreeManager.addWorktree('orphan-999', 'orphan-branch')` without going through `SessionManager` (simulating a crash where the session record was never written). Call `await cleanupService.runOnce()`. Assert `result.orphanedWorktreesRemoved` contains the orphan worktree path. Assert `fs.existsSync(orphanWorktreePath)` is `false`.
11. Write test `'full lifecycle: create → monitor → stop → cleanup → DB reflects final state'`: create a session, wait for it to appear in DB as `running` (poll `sessionRepo.get(sessionId)` with a 100ms interval up to 2s). Stop the session. Poll until DB shows `stopped` or `failed`. Run `cleanupService.runOnce()`. Assert the worktree still exists (stop does not delete it). Manually call `worktreeManager.removeWorktree(sessionId)`. Assert `fs.existsSync(worktreePath)` is `false`.
12. Ensure all tests in the file clean up their temp directories in `afterEach` even if the test throws, by using `try/finally` inside `afterEach` or relying on the helper's cleanup function.

**Key files**: src/terminal/__integration__/session-lifecycle.test.ts, src/terminal/__integration__/helpers.ts, vitest.config.ts

**Verification**:
```bash
npm run build && npm run test -- src/terminal/__integration__/ --reporter=verbose --testTimeout=30000
```

---

# Phase 3: Phase 3 – Web Server: Express + WebSocket + Auth
**Milestones: 7**

Stand up the HTTP and WebSocket server with all auth modes wired in. This is the integration layer between the terminal backend and the UI. Auth must be solid before any UI is built so it is never bolted on after the fact.

## Milestone 1: Express app scaffold: static asset serving, JSON API routes, error middleware, graceful shutdown

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

## Milestone 2: Auth middleware: environment-variable-driven selection of no-auth, static bearer token, or Entra ID OIDC

1. Install `helmet` and `cors` packages: `npm install helmet cors` and `npm install --save-dev @types/cors`.
2. Create `src/web/middleware/security.ts` exporting `securityMiddleware(): express.RequestHandler[]`.
3. Configure `helmet()` with CSP directives: `default-src 'self'`, `script-src 'self' 'unsafe-inline'`, `style-src 'self' 'unsafe-inline'`, `connect-src 'self' ws://127.0.0.1:*`, `img-src 'self' data:`. Set `crossOriginEmbedderPolicy: false`.
4. Configure `cors()` with `origin: ['http://localhost:3000', 'http://127.0.0.1:3000']`, `methods: ['GET', 'POST', 'DELETE']`, `allowedHeaders: ['Content-Type', 'Authorization']`, `credentials: false`.
5. In `createApp`, spread `securityMiddleware()` after `requestLogger` and before routes.
6. Document in a comment why `unsafe-inline` is permitted for scripts.

**Key files**: src/web/app.ts, src/web/middleware/security.ts

**Verification**:
```bash
npm run build && node dist/web/start-server.js & sleep 1 && curl -sI http://localhost:3000/health | grep -i 'x-content-type-options' && curl -sI http://localhost:3000/health | grep -i 'x-frame-options' && kill %1
```

## Milestone 3: WebSocket upgrade handler: /ws/terminal/:id route, PTY stream piped to ws client, resize messages, indefinite read timeout

1. Create `src/web/auth/types.ts` with `AuthenticatedUser` interface and Express `Request` augmentation.
2. Define `AuthMode = 'none' | 'token' | 'oidc'` and `AuthConfig` interface. Export `loadAuthConfig()` reading from env vars.
3. Create `src/web/auth/no-auth.ts` exporting `noAuthMiddleware()`.
4. Create `src/web/auth/token-auth.ts` using `crypto.timingSafeEqual` for constant-time token comparison.
5. Create `src/web/auth/oidc-auth.ts` using `passport` + `openid-client`. Install: `npm install passport openid-client express-session`.
6. Create `src/web/auth/index.ts` exporting `buildAuthMiddleware(config: AuthConfig)` that selects the correct strategy.
7. Make `createApp` async and wire auth middleware before routes.
8. Write unit tests for token auth middleware.

**Key files**: src/web/auth/types.ts, src/web/auth/no-auth.ts, src/web/auth/token-auth.ts, src/web/auth/oidc-auth.ts, src/web/auth/index.ts, src/web/app.ts

**Verification**:
```bash
npm run build && npm test -- src/web/auth/ && AUTH_MODE=none node dist/web/start-server.js & sleep 1 && curl -sf http://localhost:3000/api/health && kill %1
```

## Milestone 4: REST API routes: POST /api/sessions, GET /api/sessions, DELETE /api/sessions/:id, POST /api/sessions/:id/send, GET /api/instances

1. Create `src/web/utils/sanitise.ts` with `sanitiseShellArg`, `sanitiseBranchName`, `sanitisePath`.
2. Create `src/web/utils/git-utils.ts` with `executeGit` using `child_process.spawn` (never `exec`).
3. Create `src/web/middleware/validate.ts` with `validateBody<T>(schema: ZodSchema<T>)`. Install `zod`.
4. Implement `POST /sessions`, `GET /sessions`, `DELETE /sessions/:id`, `POST /sessions/:id/send`, `GET /instances`.
5. Write route tests using `supertest`.

**Key files**: src/web/routes/api.ts, src/web/utils/sanitise.ts, src/web/utils/git-utils.ts, src/web/middleware/validate.ts

**Verification**:
```bash
npm run build && npm test -- src/web/routes/ src/web/utils/
```

## Milestone 5: Shell injection sanitisation utility and git utility wrappers (executeGit)

1. Install `ws`: `npm install ws && npm install --save-dev @types/ws`.
2. Create `src/web/ws/ws-server.ts` with `attachWebSocketServer(server, deps)`. Use `noServer: true` and handle upgrades manually.
3. Enforce auth on WebSocket upgrade before completing the handshake.
4. Create `src/web/ws/terminal-ws.ts` with `handleTerminalConnection(ws, sessionId, engine)`.
5. Subscribe to PTY stdout and send as JSON `{ type: 'output', data }`.
6. Handle incoming `{ type: 'input' }` and `{ type: 'resize' }` messages.
7. Store `onData` disposable and call `.dispose()` on WebSocket close.
8. Add 30-second server-side ping interval.
9. Wire `attachWebSocketServer` into `startServer`.

**Key files**: src/web/ws/terminal-ws.ts, src/web/ws/ws-server.ts, src/web/server.ts

**Verification**:
```bash
npm run build && npm test -- src/web/ws/
```

## Milestone 6: CORS and security headers (helmet.js); localhost-only bind with HTTPS expected from Caddy

1. Create `src/web/__tests__/helpers/test-server.ts` with `createTestServer(authConfig)`.
2. Write `no-auth` suite: health check returns 200 without credentials.
3. Write `token` suite: missing/wrong token → 401; correct token → 200; partial token → 401.
4. Write `oidc` suite: mock `Issuer.discover`; unauthenticated API → 401; unauthenticated page → 302.
5. Write WebSocket auth test: no-auth upgrade → connection closed; correct token → OPEN.

**Key files**: src/web/__tests__/auth-integration.test.ts, src/web/__tests__/helpers/test-server.ts

**Verification**:
```bash
npm run build && npm test -- src/web/__tests__/auth-integration.test.ts --reporter=verbose
```

## Milestone 7: Auth integration tests
*(Covered by Milestone 6 above — auth integration tests are the deliverable of M3.6/M3.7.)*

---

# Phase 4: Phase 4 – HTMX Desktop UI: Session Dashboard
**Milestones: 7**

## Milestone 1: HTML layout shell: sidebar nav, session grid, header — matching Hive aesthetic with CSS custom properties for blue accent

1. Create `src/web/public/css/tokens.css` with CSS custom properties for the full design token set (blues, surfaces, borders, typography).
2. Create `src/web/public/css/layout.css` with `.orcha-layout` CSS grid, sidebar, header, and main area.
3. Create `src/web/public/css/components.css` with `.btn`, `.badge`, `.card`, `.session-grid` base styles.
4. Create `src/web/views/layout.html` with full-page shell including sidebar nav and `{{{body}}}` slot.
5. Create `src/web/views/dashboard.html` with session grid and HTMX loading skeleton.
6. Add sidebar nav with Sessions, Presets links and version badge.
7. Create `src/web/routes/dashboard.ts` rendering the layout.
8. Vendor `htmx.min.js` into `src/web/public/vendor/`.

**Key files**: src/web/views/layout.html, src/web/views/dashboard.html, src/web/public/css/tokens.css, src/web/public/css/layout.css, src/web/public/css/components.css

## Milestone 2: HTMX session card components: status badge, branch name, timestamps; polled via hx-trigger every 2s

1. Add session card sub-component CSS with `.badge--running` pulse animation.
2. Create `src/web/views/partials/session-card.html` with `hx-get` polling every 2s.
3. Create `src/web/views/partials/session-grid.html`.
4. Create `src/web/routes/sessions.ts` with `GET /api/sessions/cards` and `GET /api/sessions/:id/card`.
5. Create `formatRelativeTime` helper.

**Key files**: src/web/views/partials/session-card.html, src/web/views/partials/session-grid.html, src/web/routes/sessions.ts

## Milestone 3: New session form: HTMX-submitted POST that swaps in the new card on success

1. Add slide-in form panel CSS.
2. Add 'New Session' button in header with HTMX form panel trigger.
3. Create `src/web/views/partials/new-session-form.html` with HTMX post and `HX-Retarget`.
4. Register `GET /api/sessions/new-form` and `POST /api/sessions` routes.
5. Create `src/web/views/partials/form-error.html` for validation errors.
6. Add `express.urlencoded` middleware.

**Key files**: src/web/views/partials/new-session-form.html, src/web/views/partials/form-error.html, src/web/routes/sessions.ts

## Milestone 4: xterm.js terminal panel: loaded lazily per card, WebSocket connected to /ws/terminal/:id, fit addon for resize

1. Add terminal panel CSS.
2. Vendor xterm.js, xterm.css, addon-fit.js via `scripts/vendor-assets.js`.
3. Create `src/web/public/js/terminal.js` with `openTerminal` and `closeTerminal`.
4. Create `src/web/views/partials/terminal-panel.html` with inline dynamic import.
5. Add 'Open Terminal' button to session card footer.
6. Register `GET /api/sessions/:id/terminal` route.

**Key files**: src/web/public/js/terminal.js, src/web/views/partials/terminal-panel.html, src/web/routes/sessions.ts

## Milestone 5: Session actions: stop, kill, focus (expand terminal inline) — all HTMX requests with confirmation dialogs

1. Add confirmation dialog and focused card CSS.
2. Add Stop, Kill, Focus buttons to session card footer.
3. Create `src/web/views/partials/confirm-dialog.html`.
4. Register `GET /api/sessions/:id/confirm`, `POST /api/sessions/:id/stop`, `POST /api/sessions/:id/kill` routes.

**Key files**: src/web/views/partials/confirm-dialog.html, src/web/views/partials/session-card.html, src/web/routes/sessions.ts

## Milestone 6: Preset management UI: save/load named session configs as JSON via HTMX forms

1. Add preset list CSS.
2. Add presets section to sidebar.
3. Create `preset-list.html`, `preset-item.html`, `save-preset-form.html` partials.
4. Create `src/web/routes/presets.ts` with CRUD endpoints.
5. Mount presets router.

**Key files**: src/web/views/partials/preset-list.html, src/web/routes/presets.ts

## Milestone 7: Real-time status badge updates via Server-Sent Events (/api/events stream) replacing polling for status changes

1. Create `src/web/services/event-bus.ts` singleton.
2. Publish events on session status changes.
3. Create `src/web/routes/events.ts` with SSE stream endpoint.
4. Create `src/web/views/partials/status-badge.html`.
5. Update session card to use `hx-ext='sse'` instead of polling.
6. Vendor `htmx-ext-sse.js`.
7. Exclude SSE responses from compression middleware.

**Key files**: src/web/routes/events.ts, src/web/services/event-bus.ts, src/web/views/partials/status-badge.html, src/web/views/partials/session-card.html

---

# Phase 5: Phase 5 – Mobile UI: Single-Terminal Page
**Milestones: 6**

## Milestone 1: Mobile HTML shell: bottom-tab navigation, full-viewport terminal area, touch-friendly button sizing

1. Create `src/web/templates/mobile.html` with viewport meta tags and `#mobile-shell` root.
2. Add header, terminal area, and bottom tab nav with four tabs.
3. Create `src/web/public/mobile.css` with flex column layout and 56px tab height.
4. Create `src/web/routes/mobile.ts` serving the template.
5. Mount at `/mobile` behind auth middleware.

**Key files**: src/web/templates/mobile.html, src/web/routes/mobile.ts, src/web/public/mobile.css

## Milestone 2: Session selector: HTMX-swapped list of active sessions, tap to connect terminal

1. Create `mobile-sessions-list.html` and `mobile-session-item.html` fragments.
2. Add `GET /sessions` handler to mobile router.
3. Add `POST /connect/:sessionId` handler storing active session in `req.session`.
4. Update Sessions tab button with HTMX attributes.
5. Add session list CSS with 44px touch targets.

**Key files**: src/web/routes/mobile.ts, src/web/templates/mobile-sessions-list.html, src/web/templates/mobile-session-item.html

## Milestone 3: Full-screen xterm.js terminal with on-screen keyboard send button and swipe-to-disconnect

1. Create `mobile-terminal-frame.html` with `data-session-id` and `data-ws-url` attributes.
2. Add `GET /terminal/:sessionId` handler.
3. Create `src/web/public/mobile-terminal.js` with `initMobileTerminal` and `initSwipeToDisconnect`.
4. Add `htmx:afterSwap` listener to auto-boot terminal.
5. Add terminal frame CSS.

**Key files**: src/web/public/mobile-terminal.js, src/web/templates/mobile-terminal-frame.html

## Milestone 4: Mobile-specific CSS: safe-area insets, no-hover styles, 44px minimum touch targets

1. Add `env(safe-area-inset-*)` padding to header, tabs, and terminal area.
2. Wrap all `:hover` rules in `@media (hover: hover)`.
3. Add `:active` feedback styles.
4. Add `touch-action: manipulation` to interactive elements.
5. Add landscape orientation overrides.

**Key files**: src/web/public/mobile.css

## Milestone 5: Send-message modal: tap-to-open overlay with text input for injecting commands into the active session

1. Create `mobile-send-modal.html` with bottom sheet and `font-size: 16px` input (prevents iOS zoom).
2. Add `POST /send` and `GET /send-modal` handlers.
3. Implement `openSendModal()` in `mobile-terminal.js`.
4. Add modal CSS with safe-area bottom padding.
5. Auto-dismiss modal after successful send.

**Key files**: src/web/templates/mobile-send-modal.html, src/web/routes/mobile.ts, src/web/public/mobile.css

## Milestone 6: Connection status indicator: SSE-driven badge showing live/reconnecting/disconnected

1. Add `#conn-badge` to mobile header with SSE extension.
2. Add `GET /status-stream` SSE handler checking PTY liveness.
3. Implement WebSocket reconnect with exponential backoff in `mobile-terminal.js`.
4. Define `updateBadge(state)` function.
5. Add badge CSS for live/reconnecting/disconnected states.
6. Write smoke test in `src/web/__tests__/mobile-sse.test.ts`.

**Key files**: src/web/routes/mobile.ts, src/web/public/mobile-terminal.js, src/web/templates/mobile.html

---

# Phase 6: Phase 6 – Container Deployment & Persistence
**Milestones: 7**

## Milestone 1: Persistent volume strategy: /data mount for SQLite; worktree volume using ephemeral-with-bare-repo-on-blob hybrid

1. Create `src/storage/paths.ts` with `StoragePaths` object and `getStoragePaths()`.
2. Update `src/db/database.ts` to use `getStoragePaths().dbPath`.
3. Create `src/storage/volume-check.ts` checking `/proc/mounts` on Linux.
4. Update worktree-manager to use `getStoragePaths().worktreeBaseDir`.
5. Add `ensureBareRepo` function for the ephemeral-with-bare-repo hybrid.
6. Write `docs/storage-strategy.md`.

**Key files**: src/storage/paths.ts, src/storage/volume-check.ts, docs/storage-strategy.md

## Milestone 2: Startup diagnostics: log auth mode, storage paths, git version, node-pty version on boot

1. Create `src/diagnostics/startup.ts` with `emitStartupDiagnostics()`.
2. Gather auth_mode, db_path, git_version, node_pty_version, node_version, data_persistent, data_warning.
3. Emit structured JSON via `console.log` and warn via `console.warn` if /data is not persistent.
4. Call as first statement in `src/web/start-server.ts`.
5. Write Vitest test asserting JSON keys.

**Key files**: src/diagnostics/startup.ts, src/web/start-server.ts

## Milestone 3: Production Dockerfile: Debian-slim, non-root user, /data volume, node-pty build deps

1. Create multi-stage Dockerfile with `builder` and `runtime` stages using `node:22-bookworm-slim`.
2. Install `git fuse3 ca-certificates` in runtime stage.
3. Create non-root `orcha` user.
4. Declare `VOLUME /data` and `EXPOSE 3000`.
5. Set `USER orcha` before `CMD`.
6. Create `.dockerignore`.
7. Create `docker-compose.dev.yml` for local development.

**Key files**: Dockerfile, .dockerignore, docker-compose.dev.yml

## Milestone 4: Caddy sidecar: TLS termination, WebSocket upgrade support, automatic Let's Encrypt

1. Create `caddy/Caddyfile` with WebSocket matcher and `reverse_proxy localhost:3000`.
2. Add `tls {$ACME_EMAIL}` for Let's Encrypt.
3. Create `caddy/Dockerfile`.
4. Write `docs/caddy-sidecar.md`.
5. Update `src/storage/paths.ts` with `caddyDataDir`.
6. Validate Caddyfile syntax via Docker.

**Key files**: caddy/Caddyfile, caddy/Dockerfile, docs/caddy-sidecar.md

## Milestone 5: Azure Container Apps Bicep: container app, environment, NFS volume, managed identity

1. Create `infra/modules/storage.bicep` with Storage Account, Blob container, and File Share.
2. Create `infra/modules/container-env.bicep` with managed environment and Azure Files storage.
3. Create `infra/modules/container-app.bicep` with orcha + caddy containers and /data volume mount.
4. Create `infra/main.bicep` chaining the modules with managed identity for ACR pull.
5. Create `infra/parameters.example.json`.
6. Write `docs/deployment-guide.md`.

**Key files**: infra/main.bicep, infra/modules/container-app.bicep, infra/modules/container-env.bicep, infra/modules/storage.bicep

## Milestone 6: GitHub Actions CI: build, test, push images to Azure Container Registry on main merge

1. Create `.github/workflows/ci.yml` running `npm ci`, `npm run build`, `npm run test` on every push.
2. Create `.github/workflows/push-images.yml` triggered on CI success, using OIDC for Azure auth.
3. Build and push both `orcha` and `orcha-caddy` images tagged with git SHA.
4. Enable `DOCKER_BUILDKIT=1`.

**Key files**: .github/workflows/ci.yml, .github/workflows/push-images.yml

## Milestone 7: GitHub Actions CD: deploy to Container Apps on registry push with health check gate

1. Create `/health` route returning `{ status, uptime, db, dataDir, timestamp }` (unauthenticated).
2. Create `.github/workflows/cd.yml` triggering on successful image push.
3. Run `az containerapp update` with the new image tag.
4. Poll revision provisioning state with retry loop.
5. Gate on `curl --retry` health check.
6. Post GitHub deployment status.

**Key files**: .github/workflows/cd.yml, src/web/routes/health.ts

---

# Phase 7: Phase 7 – Hardening, Observability & CLI Compat
**Milestones: 7**

## Milestone 1: Structured logging with pino: request logs, session lifecycle events, auth events, error traces

1. Create `src/logger.ts` with pino singleton and `childLogger(module)` factory.
2. Install `pino`, `pino-pretty`, `pino-http`.
3. Replace all `console.log/error` calls throughout `src/` with child loggers.
4. Register `pino-http` middleware as first `app.use()`.
5. Add `LOG_LEVEL` to `.env.example`.

**Key files**: src/logger.ts, src/web/middleware/request-logger.ts

## Milestone 2: WebSocket heartbeat and auto-reconnect: ping/pong keepalive, exponential backoff

1. Add server-side heartbeat with `isAlive` property and `ping()` every 30s.
2. Define typed WsMessage protocol.
3. Extract `connectTerminal` into a function in `terminal-client.js`.
4. Implement exponential backoff reconnect (max 8 attempts, cap 30s).
5. Write `[Reconnecting…]` feedback to xterm on reconnect.
6. Mirror pattern in `mobile-terminal-client.js`.

**Key files**: src/web/websocket-server.ts, src/web/public/terminal-client.js, src/web/public/mobile-terminal-client.js

## Milestone 3: Session recovery on server restart: mark detached sessions, /api/sessions/:id/reattach endpoint

1. Add `'detached'` to `SessionStatus` union.
2. Add `markDetachedSessions()` to session repository.
3. Add `recoverSession(session)` to pty-manager.
4. Call `markDetachedSessions()` on startup.
5. Register `POST /api/sessions/:id/reattach` route.
6. Create `session-detached-banner.html` fragment.
7. Write recovery tests.

**Key files**: src/terminal/pty-manager.ts, src/db/session-repository.ts, src/web/routes/sessions.ts, src/domain/session.ts

## Milestone 4: Rate limiting and request size caps (express-rate-limit)

1. Install `express-rate-limit`.
2. Create `src/web/middleware/rate-limiter.ts` with general (120/min), session-create (10/min), auth (20/15min) limiters.
3. Register `generalLimiter` on `/api/`.
4. Register `sessionCreateLimiter` on `POST /sessions`.
5. Set body size limits to `64kb`.
6. Custom 429 handler with pino logging.
7. Write rate limiter tests.

**Key files**: src/web/middleware/rate-limiter.ts, src/web/server.ts

## Milestone 5: CLI bin script: start, stop, status, web, focus, send, kill verbs

1. Create `src/cli/api-client.ts` with `OrchaApiClient` using Node 18+ `fetch`.
2. Create `src/cli/cli-main.ts` with Commander.js program and all eight verbs.
3. Create `bin/orcha.js` with shebang and dynamic import.
4. Set `"bin": { "orcha": "bin/orcha.js" }` in `package.json`.
5. Install `commander`.

**Key files**: bin/orcha.js, src/cli/api-client.ts, src/cli/cli-main.ts

## Milestone 6: End-to-end test suite covering all eight CLI verbs and REST API

1. Create `src/__tests__/helpers/test-server.ts` with in-process test server on port 0.
2. Create `src/__tests__/e2e/rest-api.test.ts` testing all REST endpoints.
3. Create `src/__tests__/e2e/cli-verbs.test.ts` testing `OrchaApiClient` methods.
4. Mock `pty-manager` to avoid real PTY spawning in CI.
5. Add `"test:e2e"` script to `package.json`.

**Key files**: src/__tests__/e2e/rest-api.test.ts, src/__tests__/e2e/cli-verbs.test.ts, src/__tests__/helpers/test-server.ts

## Milestone 7: README, GETTING-STARTED, and deployment guide covering all three auth modes

1. Rewrite `README.md` with description, features, four-command quickstart, links to docs.
2. Write `GETTING-STARTED.md` with prerequisites, install, config, local run, first session, CLI usage, troubleshooting.
3. Write `docs/auth-modes.md` covering no-auth, static token, Entra ID OIDC.
4. Write `docs/deployment.md` covering Azure Container Apps deployment.
5. Update `.env.example` with all environment variables and descriptions.
6. Install `markdownlint-cli2` and add `"lint:docs"` script.
7. Create `.markdownlint.json`.

**Key files**: README.md, GETTING-STARTED.md, docs/auth-modes.md, docs/deployment.md, .env.example
