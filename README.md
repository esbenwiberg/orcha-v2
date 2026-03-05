```
  ___  ____   ____ _   _    _
 / _ \|  _ \ / ___| | | |  / \
| | | | |_) | |   | |_| | / _ \
| |_| |  _ <| |___|  _  |/ ___ \
 \___/|_| \_\\____|_| |_/_/   \_\
```

# Orcha

**Self-hosted dashboard for running Claude Code agent sessions in isolated git worktrees.**

Orcha manages repos, credential profiles, presets, and sandboxed terminal sessions through a clean web UI — so you can run multiple Claude Code agents in parallel without them stepping on each other.

---

## Features

- **Isolated worktrees** — each agent session gets its own git worktree, preventing conflicts between parallel tasks
- **Credential sandboxing** — provision scoped Azure, GitHub, and DevOps credentials per session with automatic revocation on exit
- **Presets** — save repo + credential combos for one-click session launch
- **Live terminals** — PTY-backed terminal sessions streamed to the browser
- **Session lifecycle** — audit log of status events for every session
- **Landlock sandboxing** — optional filesystem sandboxing via Linux Landlock LSM
- **SSE events** — real-time UI updates via server-sent events
- **Single-file DB** — SQLite via better-sqlite3, zero external dependencies

## Stack

| Layer | Tech |
|-------|------|
| Runtime | Node.js 22, TypeScript (ESM) |
| Web | Express + ETA templates + HTMX |
| Database | better-sqlite3 (SQLite) |
| Terminal | node-pty |
| Infra | Azure Container Apps + ACR, Caddy reverse proxy |

## Quick Start

```bash
# Install dependencies
npm install

# Build
npm run build

# Run locally (port 3001 to avoid conflicts)
PORT=3001 ORCHA_DATA_DIR=./data node dist/web/start-server.js
```

Then open [http://localhost:3001](http://localhost:3001).

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `ORCHA_DATA_DIR` | `/data` | Persistent data directory (DB + repos) |
| `SANDBOX_MODE` | `none` | `none` or `landlock` |
| `NODE_ENV` | `production` | |

## Development

```bash
npm run build:check   # type check (no emit)
npm run build         # compile to dist/
npm test              # vitest
npm run lint          # eslint
npm run format        # prettier
```

## Deployment

```bash
# Build + push image and update Azure Container App
bash scripts/deploy-app.sh

# Tail logs
bash scripts/logs.sh
bash scripts/logs.sh --follow
bash scripts/crash-logs.sh
```

## Project Structure

```
src/
  index.ts                  # entrypoint
  web/
    app.ts                  # Express app + dependency wiring
    routes/                 # HTMX + API route handlers
    views/                  # ETA templates (pages, partials, layouts)
  db/
    migrations/             # sequential SQL migrations
    *-store.ts              # data access per domain
  terminal/
    session-manager.ts      # PTY lifecycle + worktree management
    pty-manager.ts          # node-pty wrapper
  credentials/
    credential-manager.ts   # parallel provision + rollback
    providers/              # azure, github, devops
  sandbox/
    sandbox-command.ts      # landlock-exec wrapper
```

## License

MIT
