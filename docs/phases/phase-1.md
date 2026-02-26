# Phase 1: Foundation — Repo, Toolchain & Core Domain

**Status: Complete**
**Milestones: M1–M7 | Tests: 41 passing**

## What was built

Phase 1 establishes the entire project foundation: TypeScript toolchain, domain type contracts, SQLite persistence layer, and Docker runtime packaging. Nothing is user-facing yet, but every subsequent phase depends on these contracts and services being stable.

### M1 — Toolchain
Strict ESM TypeScript project with tsup build, ESLint 9 flat config, Prettier 3, and Vitest 4.

Path aliases configured across both `tsconfig.json` and `vitest.config.ts`:
- `@orcha/domain` → `src/domain/index.ts`
- `@orcha/db` → `src/db/index.ts`

### M2 — Domain types
Pure TypeScript contracts with no I/O dependencies.

- `SessionStatus` union: `pending | starting | running | paused | completed | failed | cancelled`
- Interfaces: `WorktreeInfo`, `SessionConfig`, `Session`, `InstanceInfo`
- `VALID_TRANSITIONS` map, `isValidTransition`, `assertValidTransition` with typed TypeError messages

### M3 — SQLite + migrations
- `openDatabase(dataPath)` handles `:memory:` for tests; sets WAL, foreign keys, synchronous=NORMAL
- `getDb()` singleton reads `DATA_PATH` env var (default `/data`)
- `runMigrations(db, dir)` runs versioned `.sql` files transactionally, tracks applied versions in `schema_migrations`
- Schema: `instances`, `sessions` (with FK to instances), `status_events` (with FK to sessions)

### M4 — InstanceRegistry
`InstanceRegistry` class backed by the `instances` table:
- `registerInstance` with no-overwrite guard (throws TypeError if id exists)
- `getInstance`, `listInstances`, `unregisterInstance`, `updateLastSeen`

### M5 — SessionStore
`SessionStore` class backed by `sessions` and `status_events` tables:
- `createSession` — atomic transaction, auto-incrementing `displayId`, UUID `id`
- `getSession`, `getSessionByDisplayId`, `listSessions(instanceId?)`
- `updateStatus` — validates transition via `assertValidTransition`, writes `status_events` row, sets `startedAt`/`completedAt` on appropriate transitions
- `updateSession` — patches `errorMessage` and `exitCode`
- `deleteSession` — cascades delete to `status_events` before removing the session row

### M6 — Business invariant tests
8 cross-service integration tests covering FK enforcement, no-overwrite guards, full status lifecycle, terminal-state finality, and event audit trail correctness.

### M7 — Docker
- Multi-stage Dockerfile: `builder` stage (compiles TypeScript) → `runtime` stage (node:20-slim, non-root `node` user, `/data` volume)
- `Caddyfile` with `reverse_proxy orcha:3000` and `tls internal`
- `docker-compose.yml` with `orcha` + `caddy:2-alpine` services, named volumes (`orcha_data`, `caddy_data`, `caddy_config`), internal bridge network

## Key files

| File | Purpose |
|---|---|
| `src/domain/types.ts` | SessionStatus, Session, WorktreeInfo, SessionConfig, InstanceInfo |
| `src/domain/status-transitions.ts` | VALID_TRANSITIONS, isValidTransition, assertValidTransition |
| `src/domain/index.ts` | Re-exports entire domain surface |
| `src/db/connection.ts` | openDatabase, getDb singleton |
| `src/db/migrations/001_initial_schema.sql` | Full DDL for instances, sessions, status_events |
| `src/db/migrate.ts` | runMigrations — versioned, transactional, idempotent |
| `src/db/instance-registry.ts` | InstanceRegistry CRUD |
| `src/db/session-store.ts` | SessionStore CRUD with transition enforcement |
| `src/db/invariants.test.ts` | Cross-service business invariant tests |
| `src/db/index.ts` | Re-exports all db public surface |
| `Dockerfile` | Multi-stage build, non-root, /data volume |
| `docker-compose.yml` | orcha + Caddy sidecar, named volumes |

## Verification

```bash
npm run format:check   # 0 warnings
npm run lint           # 0 warnings
npm run build:check    # 0 type errors
npm test               # 41 tests, 5 test files, all passing
```

## Notes for future phases

- `InstanceInfo.activeSessions` is persisted in the DB column but is not auto-maintained by any trigger — Phase 2 SessionManager is responsible for incrementing/decrementing it.
- `getDb()` singleton is process-global; test files always call `openDatabase(':memory:')` directly to get isolated handles.
- The `@orcha/db` path alias does not yet export `InstanceRegistry` or `SessionStore` types — only the classes. Downstream phases should import types from `@orcha/domain`.
