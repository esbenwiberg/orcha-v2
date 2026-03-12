# How the Validate MCP Works

The validate MCP is a **per-session MCP server** that Orcha automatically injects into every Claude Code session. It lets the agent spin up, inspect, and tear down a live preview of the app it's working on — without leaving the conversation.

## What it is

An MCP server (`orcha-validate`) exposed over **Streamable HTTP** at:

```
{ORCHA_HOST}/mcp/validate/{sessionId}
```

Orcha automatically adds it to the session's `.claude/settings.json` under the key `"validate"` with `type: "http"`. The agent doesn't need to configure anything — it just shows up as available tools.

## Tools it exposes

| Tool | What it does |
|---|---|
| `validate_start` | Builds the app (optional), starts it (process or docker compose), polls a health endpoint until ready |
| `validate_stop` | Kills the running validation environment |
| `validate_status` | Checks if it's running, what port, etc. |
| `validate_logs` | Returns recent stdout/stderr from the running process |
| `validate_browse` | Navigates Playwright to a URL on the running app, returns a **screenshot** + page title + console errors |
| `validate_screenshot` | Takes another screenshot of the current page (or a CSS-selected element) |
| `validate_extract` | Extracts text/HTML/attributes from elements matching a CSS selector |
| `validate_console` | Returns buffered browser console logs |

## How it knows what to run

The repo (and optionally preset) can pre-configure validation defaults:

- **`validateMode`**: `"serve"` (run a process) or `"docker"` (docker compose)
- **`validateBuild`**: build command, e.g. `"npm run build"`
- **`validateStart`**: start command, e.g. `"node dist/server.js"`
- **`validateHealth`**: health check path, e.g. `"/health"`
- **`validateHealthPort`**: if the health endpoint is on a different port than the app
- **`validateComposeFile`**: path to compose file for docker mode
- **`validateTimeout`**: auto-stop timeout in seconds (default 300)
- **`validateReadyDelay`**: extra seconds to wait after health passes (for bundler warmup)
- **`validateEnv`**: extra env vars to inject

These get **snapshotted into the session config** at creation time so retries are deterministic. The agent can also **override any of these** via `validate_start` tool arguments.

## Can my repo support it?

A repo can use the validate MCP if:

1. **It has a way to build + serve locally** — either a start command (`node dist/server.js`, `npm start`, etc.) or a docker compose file
2. **Ideally it has a health endpoint** — so `validate_start` can poll it and know when the app is ready. Without one, it's just a blind timeout which is flaky
3. **The repo config in Orcha has the validate fields filled in** — `validateMode`, `validateStart`, `validateHealth` at minimum for serve mode

That's it. There's no special code or SDK the repo needs. The MCP server runs on the Orcha side and just executes commands in the session's worktree. Playwright runs server-side too — the agent gets screenshots back as base64 images.

## The key mental model

The agent calls `validate_start` → Orcha runs the build/start commands in the worktree → polls health → once healthy, the agent can `validate_browse` to visually inspect pages → see screenshots + console errors → iterate on fixes → `validate_stop` when done.
