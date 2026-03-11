<p align="center">
  <img src="src/web/public/img/logo.png" alt="Orcha" width="280" />
</p>

<h1 align="center">Orcha</h1>

<p align="center">
  <strong>Self-hosted dashboard for running Claude Code agent sessions in isolated git worktrees.</strong>
</p>

<p align="center">
  Run multiple Claude Code agents in parallel — each in its own worktree with scoped credentials and optional filesystem sandboxing — all managed through a clean web UI.
</p>

---

## Features

- **Isolated worktrees** — each agent session gets its own git worktree, preventing conflicts between parallel tasks
- **Credential sandboxing** — provision scoped Azure, GitHub, and DevOps credentials per session with automatic revocation on exit
- **Presets** — save repo + credential + model combos for one-click session launch
- **Live terminals** — PTY-backed terminal sessions streamed to the browser via xterm.js
- **Preview proxy** — access agent-started dev servers (e.g. Storybook) through the dashboard with `/validate/` URL proxying
- **SDK management** — install and manage SDKs (Azure CLI, GitHub CLI, .NET, Power Platform CLI) available to agent sessions
- **Multiple model providers** — configure API key, Max/Pro (OAuth), or Azure Foundry per session
- **Landlock sandboxing** — optional filesystem sandboxing via Linux Landlock LSM
- **Authentication** — none, token-based, or OIDC (e.g. Entra ID) authentication modes
- **SSE events** — real-time UI updates via server-sent events
- **Single-file DB** — SQLite via better-sqlite3, zero external dependencies
- **Devguard CLI** — standalone CLI tool for secret redaction hooks and credential lifecycle management

## Stack

| Layer | Tech |
|-------|------|
| Runtime | Node.js 22, TypeScript (ESM) |
| Web | Express 5 + ETA templates + HTMX |
| Database | better-sqlite3 (SQLite) |
| Terminal | node-pty + xterm.js |
| CSS | Tailwind CSS (via PostCSS) |
| Infra | Azure Container Apps + ACR, Caddy reverse proxy |

---

## Getting Started

### Prerequisites

- **Node.js 22+** and npm
- **Git** (for worktree management)
- A Claude Code API key or Max/Pro subscription

### Install and Run

```bash
# Clone the repo
git clone https://github.com/anthropics/orcha-v2.git
cd orcha-v2

# Install dependencies
npm install

# Build (compiles TypeScript + CSS)
npm run build

# Start the server
PORT=3001 ORCHA_DATA_DIR=./data node dist/web/start-server.js
```

Open [http://localhost:3001](http://localhost:3001) in your browser.

### First Steps

1. **Add a repo** — go to **Repos** and register a git repository URL. Orcha clones it as a bare repo and creates worktrees for each session.
2. **Create a preset** _(optional)_ — save a repo + credential + model combination under **Presets** for quick session launch.
3. **Start a session** — click **New Session**, pick a repo (or preset), and launch. A fresh worktree is created and a Claude Code terminal opens in the browser.
4. **Configure credentials** _(optional)_ — under **Credentials**, set up Azure, GitHub, or DevOps credential profiles. Sessions using a profile get scoped tokens that are auto-revoked on exit.

### Docker

```bash
docker build -t orcha .
docker run -p 3000:3000 -v orcha-data:/data orcha
```

The container includes Claude Code, GitHub CLI, Azure CLI, Playwright, and the Landlock sandbox binary pre-installed.

---

## Configuration

### Core

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `ORCHA_DATA_DIR` | `/data` | Persistent data directory (DB, bare repos) |
| `ORCHA_DB_DIR` | same as `ORCHA_DATA_DIR` | SQLite DB directory (use `/tmp` on Azure Files) |
| `ORCHA_HOST` | _(auto)_ | External host URL override for preview URLs and task links |
| `SANDBOX_MODE` | `none` | `none` or `landlock` |
| `NODE_ENV` | `production` | |

### Authentication

| Variable | Default | Description |
|---|---|---|
| `AUTH_MODE` | `none` | `none`, `token`, or `oidc` |
| `AUTH_TOKEN` | — | Required when `AUTH_MODE=token` |
| `SESSION_SECRET` | _(random)_ | Cookie signing secret (random per restart if unset) |
| `OIDC_CLIENT_ID` | — | OIDC client ID (required for `oidc` mode) |
| `OIDC_CLIENT_SECRET` | — | OIDC client secret |
| `OIDC_DISCOVERY_URL` | — | OIDC discovery endpoint |
| `OIDC_REDIRECT_URI` | — | OIDC callback URL |

### Model Providers

Sessions can be configured to use different Claude providers:

- **API Key** — set `ANTHROPIC_API_KEY` in the environment or per-session
- **Max/Pro (OAuth)** — browser-based OAuth flow, no API key needed
- **Azure Foundry** — set `CLAUDE_CODE_USE_FOUNDRY=1` with appropriate credentials

---

## Development

```bash
npm run build:check   # TypeScript type check (no emit)
npm run build         # tsup compile + PostCSS → dist/
npm test              # vitest
npm run lint          # eslint
npm run format        # prettier
npm run css:watch     # rebuild CSS on changes
```

### Local Development

Orcha v2 uses **port 3001** locally by default to avoid conflicts with other services:

```bash
PORT=3001 ORCHA_DATA_DIR=./data node dist/web/start-server.js
```

## Deployment

```bash
# Build + push Docker image and update Azure Container App
bash scripts/deploy-app.sh

# Tail logs
bash scripts/logs.sh
bash scripts/logs.sh --follow
bash scripts/crash-logs.sh
bash scripts/crash-logs.sh --system    # OOM, restarts, kills
```

---

## Project Structure

```
src/
  index.ts                    # entrypoint
  sdk-installer.ts            # SDK install/management (az, gh, dotnet, pac)
  host-url.ts                 # external URL resolution
  web/
    app.ts                    # Express app + dependency wiring
    start-server.ts           # HTTP server bootstrap
    auth/                     # Auth modes: none, token, OIDC
    routes/                   # HTMX + API route handlers
    views/                    # ETA templates (pages, partials, layouts)
    ws/                       # WebSocket server (terminal streaming)
  db/
    migrations/               # sequential SQL migrations
    *-store.ts                # data access per domain
  terminal/
    session-manager.ts        # PTY lifecycle + worktree management
    pty-manager.ts            # node-pty wrapper + sandbox integration
  credentials/
    credential-manager.ts     # parallel provision + rollback
    providers/                # azure, github, devops
  sandbox/
    sandbox-command.ts        # landlock-exec wrapper
    sandbox-config.ts         # reads SANDBOX_MODE env var
  model-config/
    env-builder.ts            # per-session model/provider env vars
  devguard/
    cli.ts                    # standalone CLI wizard
    redact-hook.ts            # PostToolUse hook for secret redaction
    scrub-history.ts          # retroactive JSONL history scrubbing
  tasks/
    execute.ts                # background task execution
```

## License

MIT
