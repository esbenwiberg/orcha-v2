# Plan: devguard — JIT Credential Management in orcha-v2

## Context

When doing AI-assisted development with Claude/orcha, all cloud CLI commands (az, gh, az devops) run under the user's full credentials. This is dangerous — a mistake can affect production resources across all subscriptions, repos, and DevOps orgs.

The goal is a credential scoping system (devguard) built into orcha-v2 that:
- Provisions short-lived, scoped JIT credentials before a Claude session starts
- Ties credentials to sessions (auto-revoked when session ends)
- Shows expiry/status in the orcha dashboard
- Also ships as a standalone `devguard` CLI for use outside orcha

**Repo**: `/home/ewi/repos/orcha-clones/orcha-v2`

---

## Architecture

```
src/
  credentials/              ← shared core (used by both orcha + devguard CLI)
    types.ts                ← CredentialProfile, ActiveCredentials, Provider interfaces
    credential-manager.ts   ← orchestrates provision/revoke across providers
    providers/
      azure.ts              ← Azure SP create/delete via @azure/arm-authorization
      github.ts             ← GitHub fine-grained PAT via REST API
      devops.ts             ← Azure DevOps PAT via VSSPS API
  devguard/                 ← standalone CLI
    cli.ts                  ← @clack/prompts wizard (main entry)
    config.ts               ← reads .devguard.yaml from cwd
    store.ts                ← ~/.devguard/sessions.json (file-based, no daemon)
  db/
    migrations/
      003_credential_profiles.sql   ← NEW
    credential-store.ts             ← NEW: CRUD for profiles + session_credentials
  web/
    routes/
      credentials.ts        ← NEW: HTMX routes for credential profile management
    views/partials/
      credential-profile-item.html  ← NEW
      credential-profile-list.html  ← NEW
      credential-status-strip.html  ← NEW: added to session-card
      credential-profile-form.html  ← NEW
      credentials-panel.html        ← NEW: dashboard overview panel

bin/
  devguard.js               ← NEW: entry point for standalone CLI
```

---

## Phase 1: Core Credential Providers

### New deps to add
```json
"@azure/identity": "^4.x",
"@azure/arm-authorization": "^9.x",
"@clack/prompts": "^0.x",
"js-yaml": "^4.x"
```

### `src/credentials/types.ts`
```typescript
interface CredentialProfile {
  id: string
  name: string
  durationHours: number
  azure?: { subscriptionId: string; resourceGroups: string[]; role: string }
  github?: { repos: string[]; permissions: string[] }
  devops?: { org: string; project: string; scopes: string[] }
  createdAt: Date
}

interface ActiveCredentials {
  id: string
  sessionId?: string          // null = standalone devguard session
  profileId: string
  profileName: string
  azureSpName?: string        // for cleanup
  githubPatId?: string        // for revoke
  devopsPatId?: string        // for revoke
  expiresAt: Date
  revokedAt?: Date
}
```

### `src/credentials/providers/azure.ts`
- `provision(profile)` → `az ad sp create-for-rbac` via child_process (uses existing az CLI auth) — scoped to specified resource groups + role, with explicit `--years 0 --only-show-errors`
- `revoke(spName)` → `az ad sp delete --id`
- Returns `{ spName, clientId, clientSecret, tenantId }` as env vars

### `src/credentials/providers/github.ts`
- `provision(profile)` → POST `https://api.github.com/user/personal-access-tokens` with fine-grained scopes
- `revoke(patId)` → DELETE the PAT via API
- Uses `GH_TOKEN` or `GITHUB_TOKEN` from env for bootstrap auth
- Returns `{ GH_TOKEN: "<new-scoped-token>" }`

### `src/credentials/providers/devops.ts`
- `provision(profile)` → POST `https://vssps.dev.azure.com/{org}/_apis/tokens/pats`
- `revoke(patId)` → DELETE via same API
- Uses `AZURE_DEVOPS_EXT_PAT` from env for bootstrap auth
- Returns `{ AZURE_DEVOPS_EXT_PAT: "<new-scoped-token>" }`

### `src/credentials/credential-manager.ts`
```typescript
class CredentialManager {
  async provision(profile: CredentialProfile): Promise<ActiveCredentials & { env: Record<string, string> }>
  async revoke(activeCredId: string): Promise<void>
  async revokeExpired(): Promise<void>
}
```
- Calls each provider in parallel
- Aggregates all env vars into a flat `Record<string, string>`
- On partial failure: revoke already-provisioned credentials, throw

---

## Phase 2: Database Layer

### `src/db/migrations/003_credential_profiles.sql`
```sql
CREATE TABLE IF NOT EXISTS credential_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  duration_hours INTEGER NOT NULL DEFAULT 4,
  azure_json TEXT,
  github_json TEXT,
  devops_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_credentials (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id),
  profile_id TEXT REFERENCES credential_profiles(id),
  azure_sp_name TEXT,
  github_pat_id TEXT,
  devops_pat_id TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_credentials_session_id ON session_credentials(session_id);
CREATE INDEX IF NOT EXISTS idx_session_credentials_expires_at ON session_credentials(expires_at);
```

### `src/db/credential-store.ts`
- Follow exact same store pattern as `preset-store.ts`
- `listProfiles()`, `getProfile(id)`, `createProfile(input)`, `deleteProfile(id)`
- `createSessionCredentials(input)`, `getBySessionId(sessionId)`, `markRevoked(id)`
- `listExpired()` → returns session_credentials where expires_at < now and revoked_at IS NULL
- Export singleton instance (match pattern of other stores)

---

## Phase 3: Orcha Dashboard Integration

### Extend new-session form (`src/web/views/partials/new-session-form.html`)
Add optional credential profile dropdown after the existing fields:
```html
<div class="form-group">
  <label for="ns-cred-profile">Credential Profile <span class="text-muted">(optional)</span></label>
  <select id="ns-cred-profile" name="credentialProfileId">
    <option value="">None — use ambient credentials</option>
    <% for (const p of it.credentialProfiles) { %>
      <option value="<%= p.id %>"><%= p.name %> (<%= p.durationHours %>h)</option>
    <% } %>
  </select>
</div>
```
Route `GET /api/sessions/new-form` must now also fetch `credentialStore.listProfiles()` and pass to template.

### Session creation (`src/web/routes/sessions.ts`)
When `credentialProfileId` present in POST body:
1. Fetch profile from DB
2. Call `credentialManager.provision(profile)` → get `{ activeCreds, env }`
3. Store `session_credentials` row
4. Merge env vars into `SessionConfig.env` (already supported!) — credentials are injected directly into the PTY process environment

### New credential strip partial (`src/web/views/partials/credential-status-strip.html`)
```html
<% if (it.credentials) { %>
<div class="cred-strip" id="cred-strip-<%= it.sessionId %>">
  <span class="text-xs text-muted font-mono">🔑 <%= it.credentials.profileName %></span>
  <span class="cred-expiry text-xs" data-expires="<%= it.credentials.expiresAt %>">
    expires <%= it.credentials.expiresInFormatted %>
  </span>
  <button class="btn btn-xs" style="color:var(--color-error)"
    hx-post="/api/credentials/<%= it.credentials.id %>/revoke"
    hx-confirm="Revoke credentials for this session?">Revoke</button>
</div>
<% } %>
```
Add `<%~ include('partials/credential-status-strip', ...) %>` inside `session-card__body`.

### New credential routes (`src/web/routes/credentials.ts`)
```
GET    /api/credential-profiles               → list partial
GET    /api/credential-profiles/form          → create form partial
POST   /api/credential-profiles               → create profile
DELETE /api/credential-profiles/:id           → delete profile
POST   /api/credentials/:id/revoke            → revoke active credentials
GET    /api/credentials/overview              → overview panel partial (all active + expired)
```

### Dashboard credential panel (`src/web/views/partials/credentials-panel.html`)
A new sidebar section showing all active credential sets across sessions:
- Session name + profile name
- Expiry progress bar (computed server-side as percentage)
- Revoke button
- "Revoke all expired" action

Add to sidebar in `layout.html` below the presets section.

### Auto-revoke on session end
In `src/terminal/session-manager.ts`, in the PTY exit handler (already exists):
```typescript
// After session DB update to completed/failed/cancelled:
const activeCreds = credentialStore.getBySessionId(dbSessionId);
if (activeCreds && !activeCreds.revokedAt) {
  await credentialManager.revoke(activeCreds.id).catch(() => {}); // best-effort
}
```

### Cleanup service extension (`src/terminal/cleanup-service.ts`)
Add a third cleanup phase: `credentialStore.listExpired()` → revoke each via `credentialManager.revoke()`.

### SSE expiry events
Add `credential-expiry` event type to EventBus. Cleanup service emits when credentials are within 30 min of expiry, so the dashboard can show a warning state.

---

## Phase 4: Session Sandboxing (bwrap + cgroup)

Credential scoping limits *what APIs can be called*. Filesystem sandboxing limits *what files can be read or written*. Together they form a complete defence layer around each session.

### Threat model

Without sandboxing, a session running in worktree `abc` can:
- Read other worktrees (`/data/worktrees/xyz`)
- Read `/data/orcha.db` (all session metadata and credential IDs)
- Read other sessions' injected env vars via `/proc/<pid>/environ`
- Write anywhere the `orcha` user can reach

bwrap eliminates this: each session's process sees only its own worktree (mounted as `/workspace`). Everything else is invisible — not permission-denied, literally absent.

### Implementation

#### `src/sandbox/sandbox-config.ts`
```typescript
interface SandboxConfig {
  enabled: boolean
  mode: 'bwrap' | 'none'
  memoryMax: string   // e.g. '512M'
  cpuQuota: string    // e.g. '50%'
}

export function loadSandboxConfig(): SandboxConfig
// Reads: SANDBOX_MODE (default 'none'), SANDBOX_MEMORY_MAX (default '512M'),
//        SANDBOX_CPU_QUOTA (default '100%')
```

#### `src/sandbox/bwrap.ts`
```typescript
export function buildSandboxedCommand(
  worktreePath: string,
  command: string[],
  config: SandboxConfig
): string[]
```

When `mode === 'bwrap'`, wraps the command with:
```bash
systemd-run --scope --user \
  -p MemoryMax=512M \
  -p CPUQuota=50% \
  -- \
  bwrap \
  --ro-bind /usr /usr \
  --ro-bind /lib /lib \
  --ro-bind /lib64 /lib64 \
  --ro-bind /bin /bin \
  --ro-bind /etc/resolv.conf /etc/resolv.conf \   # DNS → Anthropic API
  --ro-bind /etc/ssl /etc/ssl \                   # TLS certs
  --bind <worktreePath> /workspace \              # session worktree, read-write
  --chdir /workspace \
  --unshare-pid \
  --new-session \
  --die-with-parent \
  -- <original command>
```

Network remains open (Claude needs `api.anthropic.com`). When `mode === 'none'`, returns command unchanged.

#### Integration with `PtyManager`
`src/terminal/pty-manager.ts` `spawn()` calls `buildSandboxedCommand()` before passing args to node-pty. `loadSandboxConfig()` is cached at module load.

#### Integration with credential injection
Scoped JIT credentials (from devguard Phase 1–2) are injected into `SessionConfig.env`, which node-pty passes as the PTY environment. bwrap inherits the parent's env by default, so credentials flow through without any additional plumbing.

#### Dockerfile changes
Add `bwrap` to the runtime apt install line. Add to `ENV` block:
```dockerfile
ENV SANDBOX_MODE=none \
    SANDBOX_MEMORY_MAX=512M \
    SANDBOX_CPU_QUOTA=100%
```
Default is `none` so the image works without sandboxing. Operators enable it via `SANDBOX_MODE=bwrap`.

#### Startup diagnostics
Add `sandbox_mode` and `bwrap_available` (via `which bwrap`) to `emitStartupDiagnostics()` output.

#### `docs/sandboxing.md`
Document: what bwrap isolates (filesystem only), what it doesn't (network, time, hostname), how to enable, cgroup resource limits, and the known limitation that `systemd-run --user` requires a user session bus (document fallback: run bwrap without the systemd-run wrapper when cgroup support is unavailable).

### What each layer protects

| Threat | Credential scoping | bwrap | cgroup |
|---|---|---|---|
| Session reads another worktree | ✗ | ✓ | ✗ |
| Session reads orcha.db | ✗ | ✓ | ✗ |
| Session calls production APIs | ✓ (JIT scope) | ✗ | ✗ |
| Session exhausts host memory | ✗ | ✗ | ✓ |
| Session runs forever | ✗ | ✗ | ✓ (CPU) |

### Key files

| File | Action |
|---|---|
| `src/sandbox/sandbox-config.ts` | New |
| `src/sandbox/bwrap.ts` | New |
| `src/sandbox/bwrap.test.ts` | New |
| `src/terminal/pty-manager.ts` | Modified — apply sandbox on spawn |
| `src/diagnostics/startup.ts` | Modified — log sandbox_mode, bwrap_available |
| `Dockerfile` | Modified — add bwrap, ENV defaults |
| `docs/sandboxing.md` | New |

---

## Phase 5: Standalone devguard CLI

### `.devguard.yaml` (per project, gitignored)
```yaml
name: myapp
task_profiles:
  bugfix:
    durationHours: 4
    azure:
      subscriptionId: "..."
      resourceGroups: ["myapp-dev-rg"]
      role: "Contributor"
    github:
      repos: ["myorg/myapp"]
      permissions: ["contents:write", "pull_requests:write"]
    devops:
      org: "https://dev.azure.com/myorg"
      project: "myproject"
      scopes: ["vso.code_write", "vso.work_write"]
  readonly:
    durationHours: 2
    azure:
      role: "Reader"
    github:
      permissions: ["contents:read"]
    devops:
      scopes: ["vso.code"]
```

### `src/devguard/config.ts`
- `loadConfig(cwd)` → reads `.devguard.yaml`, validates, returns typed config
- `detectServices(cwd)` → scans for `bicep/`, `.github/`, `azure-pipelines.yml` to suggest defaults

### `src/devguard/store.ts`
- File-based: `~/.devguard/sessions.json`
- `saveSession(session)`, `listSessions()`, `markRevoked(id)`, `listExpired()`

### `src/devguard/cli.ts`
Wizard flow using `@clack/prompts`:
```
1. intro() — "devguard — JIT credential manager"
2. Load .devguard.yaml (if not found, offer to scaffold)
3. select() — pick task profile
4. confirm() — show what will be provisioned, ask to proceed
5. spinner() — provision credentials
6. outro() — "Session active until HH:MM. Run: source .devguard/session.env && claude"
7. Write .devguard/session.env (gitignored)
```

Commands:
- `devguard init` — run wizard
- `devguard status` — list active sessions + expiry
- `devguard revoke [id|--all|--expired]` — cleanup
- `devguard scaffold` — generate .devguard.yaml interactively

### `bin/devguard.js`
```js
#!/usr/bin/env node
import '../dist/devguard/cli.js';
```

### `package.json` additions
```json
{
  "bin": {
    "orcha": "./bin/orcha.js",
    "devguard": "./bin/devguard.js"
  }
}
```

---

## Critical Files to Modify

| File | Change |
|------|--------|
| `package.json` | Add bin entry, add deps |
| `src/db/index.ts` | Export `credentialStore` |
| `src/web/app.ts` | Register credentials router |
| `src/web/routes/sessions.ts` | Pass profiles to new-form, provision on create, auto-revoke |
| `src/terminal/session-manager.ts` | Revoke credentials on session exit |
| `src/terminal/cleanup-service.ts` | Add expired credential cleanup phase |
| `src/web/views/partials/session-card.html` | Add credential strip |
| `src/web/views/partials/new-session-form.html` | Add profile dropdown |
| `src/web/views/layout.html` | Add credentials panel to sidebar |

---

## Build Order

1. `src/credentials/types.ts`
2. `src/credentials/providers/azure.ts` + `github.ts` + `devops.ts`
3. `src/credentials/credential-manager.ts`
4. `src/db/migrations/003_credential_profiles.sql`
5. `src/db/credential-store.ts`
6. `src/sandbox/sandbox-config.ts` + `bwrap.ts`
7. `src/terminal/pty-manager.ts` — sandbox integration
8. `src/devguard/config.ts` + `store.ts` + `cli.ts`
9. `bin/devguard.js`
10. Orcha web integration (routes, partials, session-manager hooks)

---

## CSS Additions

Add to `src/web/public/css/components.css` — no new tokens needed, reuse existing:

```css
/* Credential strip on session card */
.cred-strip {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.75rem;
  border-top: 1px solid var(--color-border);
  background: var(--color-surface);
  font-size: 0.75rem;
}
.cred-strip .cred-expiry { color: var(--color-text-muted); margin-left: auto; }
.cred-strip.is-expiring-soon .cred-expiry { color: var(--color-warning); }
.cred-strip.is-expired .cred-expiry { color: var(--color-error); }

/* Expiry progress bar in credentials panel */
.cred-bar { height: 4px; background: var(--color-border); border-radius: 2px; }
.cred-bar__fill { height: 100%; background: var(--color-success); border-radius: 2px; transition: width 1s linear; }
.cred-bar__fill.is-low { background: var(--color-warning); }
.cred-bar__fill.is-critical { background: var(--color-error); }
```

**Expiry countdown**: Server renders initial `expiresInFormatted` string (e.g. "2h 14m"). A small inline `<script>` on the credentials panel updates the countdown client-side every minute via `data-expires` ISO timestamp attribute — no SSE needed for the countdown itself. SSE only fires the `credential-expiry` warning event at the 30-min threshold to flip the `is-expiring-soon` class.

---

## Verification

1. **Unit**: `devguard scaffold` generates valid `.devguard.yaml`
2. **Provider mocks**: Test provision/revoke with `--dry-run` flag that skips actual API calls
3. **DB**: Migration applies cleanly, credential-store CRUD works
4. **CLI**: `devguard init` → picks profile → provisions → writes `session.env` → `devguard status` shows it → `devguard revoke` cleans up
5. **Orcha integration**: Create session with credential profile → verify env vars injected into PTY → stop session → verify auto-revoke fires
6. **Dashboard**: Credential strip appears on session card, expiry shown, revoke button works, overview panel lists all active credentials

---

## First Action After Approval

Copy this plan to the orcha-v2 repo so it's available when starting a Claude session from there:
```bash
mkdir -p /home/ewi/repos/orcha-clones/orcha-v2/plans
cp /home/ewi/.claude/plans/floofy-strolling-snowglobe.md \
   /home/ewi/repos/orcha-clones/orcha-v2/plans/devguard.md
```

---

## Notes

- Plan lives at: `/home/ewi/repos/orcha-clones/orcha-v2/plans/devguard.md`
- Credentials are injected via `SessionConfig.env` — no changes to PTY infrastructure needed
- Bootstrap auth (the full-permission credentials used to create JIT creds) never enters the session env — only the scoped JIT tokens do
- `.devguard/session.env` and `~/.devguard/sessions.json` must be gitignored
