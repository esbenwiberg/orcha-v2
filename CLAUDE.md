# Orcha v2

Orcha is a self-hosted dashboard for running Claude Code agent sessions in isolated git worktrees. It manages repos, credential profiles, presets, and sandboxed terminal sessions through a web UI.

## Stack

- **Runtime**: Node.js 22, TypeScript (ESM, `tsup` build)
- **Web**: Express + ETA templates + HTMX (no client-side JS framework)
- **DB**: better-sqlite3 (synchronous, single-file SQLite at `$ORCHA_DATA_DIR/orcha.db`)
- **Terminal**: node-pty for PTY sessions
- **Infra**: Azure Container Apps + ACR, Caddy reverse proxy

## Commands

```bash
npm run build:check   # TypeScript type check (no emit)
npm run build         # tsup compile → dist/
npm test              # vitest run
npm run lint          # eslint
npm run format        # prettier write
bash scripts/deploy-app.sh   # build ACR image, push, update Container App
```

## Project Structure

```
src/
  index.ts                    # entrypoint (registers instance, starts server)
  web/
    app.ts                    # Express app + AppDeps wiring
    start-server.ts           # HTTP server bootstrap
    routes/
      api.ts                  # JSON API router
      sessions.ts             # HTMX session routes
      presets.ts              # HTMX preset routes
      repos.ts                # HTMX repo routes
      credentials.ts          # HTMX credential profile routes
      claude-permissions.ts   # CRUD for .claude/settings.json
      dashboard.ts            # Page routes (SSR full pages)
      system.ts               # System stats + cleanup routes
      events.ts               # SSE event stream
      health.ts               # /health endpoint
    views/
      pages/                  # Full-page ETA templates
      partials/               # HTMX partial templates
      layouts/                # Layout wrappers
  db/
    index.ts                  # exports all stores
    migrate.ts                # runs migrations in order
    migrations/               # SQL migration files (001–005)
    session-store.ts
    preset-store.ts
    repo-store.ts
    credential-store.ts
  terminal/
    session-manager.ts        # PTY lifecycle, worktree creation, auto-revoke creds on exit
    pty-manager.ts            # node-pty wrapper + bwrap sandboxing
  credentials/
    types.ts                  # CredentialProfile, ActiveCredentials interfaces
    credential-manager.ts     # parallel provision + rollback
    providers/
      azure.ts                # DefaultAzureCredential + Graph API
      github.ts               # fine-grained PAT via REST
      devops.ts               # VSSPS PAT API
  sandbox/
    bwrap.ts                  # builds systemd-run + bwrap command
    sandbox-config.ts         # reads SANDBOX_MODE env var
  devguard/
    cli.ts                    # @clack/prompts wizard
    redact-hook.ts            # PostToolUse hook for secret redaction
    scrub-history.ts          # retroactive JSONL history scrubbing
    config.ts / store.ts      # .devguard.yaml + sessions.json
```

## Key Conventions

- **Stores**: instantiate per-router with `new FooStore(deps.db)`. `deps.db` is the shared `Database` instance passed via `AppDeps`.
- **HTMX pattern**: partials return HTML fragments. On success, forms return `''` (empty 200) and trigger a list refresh via `htmx.trigger('#slot', 'refresh')`. Errors return 422 with a re-rendered form wrapped in `partials/form-error`.
- **TypeScript**: `exactOptionalPropertyTypes: true` — never assign `key: undefined`; use spreads: `...(val !== undefined ? { key: val } : {})`.
- **Migrations**: add new SQL files to `src/db/migrations/` with the next sequence number. The migrate runner applies all unapplied migrations in order.
- **Data dir**: all persistent data lives in `ORCHA_DATA_DIR` (default `/data` in container, `./data` locally). DB file is `orcha.db`, git repos clone into `orcha.db`-sibling directories.

## DB Schema (current)

- `instances` — registered Orcha instances
- `sessions` — agent sessions (config_json + worktree_json)
- `status_events` — session lifecycle audit log
- `presets` — saved (name, repo_id, credential_profile_id)
- `repos` — registered git repositories
- `credential_profiles` — Azure/GitHub/DevOps credential configs
- `session_credentials` — active credential grants per session

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `ORCHA_DATA_DIR` | `/data` | Persistent data directory |
| `SANDBOX_MODE` | `none` | `none` / `bwrap` |
| `SANDBOX_MEMORY_MAX` | `512M` | bwrap memory limit |
| `NODE_ENV` | `production` | |
