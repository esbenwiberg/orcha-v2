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

## Bootstrap Auth Model

Devguard operates in two environments with different bootstrap mechanisms:

```
┌─────────────────────────────────────────────────────┐
│  Azure Container App (orcha server)                  │
│                                                      │
│  Bootstrap layer (shared, server-side):              │
│  ├── Azure:  Managed Identity (implicit, no login)   │
│  ├── GitHub: GITHUB_BOOTSTRAP_TOKEN (env/secret)     │
│  └── DevOps: DEVOPS_BOOTSTRAP_PAT (env/secret)       │
│                                                      │
│  Session layer (per-session, injected into PTY env): │
│  ├── AZURE_CLIENT_ID / AZURE_CLIENT_SECRET (SP)      │
│  ├── GH_TOKEN (fine-grained PAT)                     │
│  └── AZURE_DEVOPS_EXT_PAT (scoped PAT)               │
└─────────────────────────────────────────────────────┘

Developer machine (standalone devguard CLI):
├── Azure:  DefaultAzureCredential picks up az CLI session
├── GitHub: gh auth token or GH_TOKEN env var
└── DevOps: AZURE_DEVOPS_EXT_PAT env var
```

**Key invariant**: Bootstrap credentials are used briefly to provision, then
discarded. They never enter a session's env. Sessions only receive scoped JIT tokens.

### `DefaultAzureCredential` chain

`@azure/identity`'s `DefaultAzureCredential` is used for all Azure operations.
It tries in order:

1. `ManagedIdentityCredential` — succeeds in container (no login needed)
2. `AzureCliCredential` — succeeds on dev machine (`az login` already done)
3. `EnvironmentCredential` — `AZURE_CLIENT_ID` + `AZURE_CLIENT_SECRET` env vars (CI fallback)

Same code, zero config difference between environments.

### Azure permissions required

Two separate permission layers, both must be granted to the managed identity
(or the credential in the chain that resolves):

| Permission | Scope | Purpose |
|---|---|---|
| `Application.ReadWrite.OwnedBy` (AAD) | Tenant | Create/delete service principals |
| `User Access Administrator` or `Owner` (RBAC) | Subscription or RG | Assign roles to the provisioned SP |

These are granted by a subscription Owner once at setup time in Bicep:

```bicep
// Grant managed identity the ability to create SPs (AAD Graph)
resource graphPermission 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  // Application.ReadWrite.OwnedBy — must be done via az cli or portal, not Bicep
  // az ad app permission add --id <managed-identity-client-id> \
  //   --api 00000003-0000-0000-c000-000000000000 \
  //   --api-permissions 18a4783c-866b-4cc7-a460-3d5e5662c884=Role
}

// Grant role assignment rights on the target resource group(s)
resource roleAssignAdmin 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, managedIdentity.id, 'UserAccessAdmin')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '18d7d88d-d35e-4fb5-a5c3-7773c20a72d6') // User Access Administrator
    principalId: managedIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
```

### When role assignment creation is blocked

Many enterprise tenants lock down `User Access Administrator` — you can't grant
it without escalation. The Azure SP provider handles this gracefully:

**Preflight check** (runs before any provisioning):
```typescript
async preflight(profile: AzureProfile): Promise<PreflightResult> {
  // 1. Can we get a token? (managed identity / az login working)
  // 2. Can we read the target subscription? (basic access)
  // 3. Can we create role assignments? (test with a no-op check-access call)
  //    → if no: return { ok: false, reason: 'role-assignment-blocked', degraded: true }
}
```

If role assignment creation is blocked, the provider returns `degraded: true`
and the credential-manager skips Azure SP provisioning with a clear message:

```
⚠ Azure SP provisioning unavailable: managed identity lacks role assignment
  rights on subscription <id>. Options:
  • Ask a subscription Owner to grant "User Access Administrator" on the
    target resource groups to managed identity <principal-id>
  • Or: use a pre-provisioned SP pool (see below)
  GitHub and DevOps credentials will still be provisioned.
```

**Alternative: pre-provisioned SP pool**

If you can never get role assignment rights, an admin can pre-create SPs with
the desired roles, store their credentials in Key Vault, and devguard rotates
the client secret instead of creating a new SP:

```yaml
# .devguard.yaml — pool mode
azure:
  mode: pool   # vs default 'jit'
  keyVaultUrl: https://myapp-kv.vault.azure.net
  poolPrefix: devguard-pool-  # reads devguard-pool-0, devguard-pool-1, ...
```

Pool mode: fetch SP credentials from Key Vault, rotate secret, inject, return
secret to pool on revoke. Admin sets up pool once; devguard doesn't need role
assignment rights at runtime. This is opt-in and not implemented in the initial
phases.

### GitHub and DevOps bootstrap tokens

Set as Container App secrets in Bicep (same pattern as `SESSION_SECRET`):

```bicep
secrets: [
  { name: 'github-bootstrap-token', value: githubBootstrapToken }
  { name: 'devops-bootstrap-pat',   value: devopsBootstrapPat }
]
env: [
  { name: 'GITHUB_BOOTSTRAP_TOKEN', secretRef: 'github-bootstrap-token' }
  { name: 'DEVOPS_BOOTSTRAP_PAT',   secretRef: 'devops-bootstrap-pat' }
]
```

Required scopes:
- GitHub bootstrap token: classic PAT with `manage:personal_access_tokens` scope
- DevOps bootstrap PAT: PAT with "Token Administration" scope enabled

On dev machine: falls back to `GH_TOKEN`/`GITHUB_TOKEN` env var or `gh auth token`,
and `AZURE_DEVOPS_EXT_PAT` env var.

---

## Phase 1: Core Credential Providers

### New deps to add
```json
"@azure/identity": "^4.x",
"@azure/arm-authorization": "^9.x",
"@microsoft/microsoft-graph-client": "^3.x",
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
Uses `DefaultAzureCredential` from `@azure/identity` — no `az` CLI shell-out.
Works in container (managed identity) and dev machine (az CLI session) with the
same code path.

- `preflight(profile)` → verifies token acquisition, subscription access, and
  role assignment rights via a check-access call. Returns `PreflightResult`
  with `ok`, `reason`, and `degraded` fields.
- `provision(profile)` →
  1. `GraphServiceClient` (via managed identity credential): create App registration + SP
  2. Generate a client secret with TTL matching `profile.durationHours`
  3. `AuthorizationManagementClient`: assign `profile.azure.role` on each resource group
  4. Store `spName` + `appId` for cleanup
- `revoke(appId)` → delete App registration via Graph (cascades SP deletion)
- Returns `{ AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID }` as env vars
- On preflight `degraded: true`: skips provisioning, returns empty env, logs warning

### `src/credentials/providers/github.ts`
- `preflight()` → GET `/user` with bootstrap token, check `X-OAuth-Scopes` header
  for `manage:personal_access_tokens`. Returns warning if scope missing.
- `provision(profile)` → POST `https://api.github.com/user/personal-access-tokens`
  with fine-grained scopes and expiry matching `profile.durationHours`
- `revoke(patId)` → DELETE the PAT via API
- Bootstrap token resolution: `process.env.GITHUB_BOOTSTRAP_TOKEN ?? process.env.GH_TOKEN ?? execSync('gh auth token').toString().trim()`
- Returns `{ GH_TOKEN: "<new-scoped-token>" }`

### `src/credentials/providers/devops.ts`
- `preflight()` → GET profile via VSSPS API to verify bootstrap PAT is valid and
  has token management scope
- `provision(profile)` → POST `https://vssps.dev.azure.com/{org}/_apis/tokens/pats`
- `revoke(patId)` → DELETE via same API
- Bootstrap token resolution: `process.env.DEVOPS_BOOTSTRAP_PAT ?? process.env.AZURE_DEVOPS_EXT_PAT`
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

## Phase 6: Claude Permissions Editor

The orcha dashboard gets a UI for managing per-project `.claude/settings.json` — specifically the tool allow/deny lists. This removes the need to hand-edit JSON to configure what Claude can do in a given project.

### What Claude permissions look like

`.claude/settings.json` relevant fields:
```json
{
  "permissions": {
    "allow": ["Bash(git *)", "Bash(npm run *)"],
    "deny":  ["Bash(rm -rf *)", "Bash(curl * | bash *)"]
  }
}
```

Each entry is `ToolName(glob-pattern)` or bare `ToolName`. The allow list is an allowlist for otherwise-blocked patterns; the deny list overrides allow.

### New routes (`src/web/routes/claude-permissions.ts`)

```
GET    /api/claude-permissions          → render permissions panel partial
POST   /api/claude-permissions/allow    → add an allow rule { tool, pattern? }
DELETE /api/claude-permissions/allow/:encoded  → remove allow rule
POST   /api/claude-permissions/deny     → add a deny rule
DELETE /api/claude-permissions/deny/:encoded   → remove deny rule
```

All routes read/write `.claude/settings.json` in the project root. Use `fs.readFile` + `JSON.parse`, merge, `JSON.stringify` + `fs.writeFile` with an exclusive advisory lock (or single-writer queue — keep it simple).

### New partials

**`src/web/views/partials/claude-permissions-panel.html`**
```html
<div class="panel" id="claude-permissions-panel">
  <div class="panel__header">
    <h3>Claude Permissions</h3>
    <span class="text-xs text-muted">project .claude/settings.json</span>
  </div>

  <div class="panel__section">
    <h4 class="text-xs text-muted uppercase">Allow rules</h4>
    <% for (const rule of it.allow) { %>
      <div class="perm-rule perm-rule--allow">
        <code class="text-xs"><%= rule %></code>
        <button hx-delete="/api/claude-permissions/allow/<%= encodeURIComponent(rule) %>"
                hx-target="#claude-permissions-panel" hx-swap="outerHTML">×</button>
      </div>
    <% } %>
    <form hx-post="/api/claude-permissions/allow"
          hx-target="#claude-permissions-panel" hx-swap="outerHTML">
      <input name="rule" placeholder="Bash(git *)" class="input input--sm" />
      <button class="btn btn-xs">Add allow</button>
    </form>
  </div>

  <div class="panel__section">
    <h4 class="text-xs text-muted uppercase">Deny rules</h4>
    <% for (const rule of it.deny) { %>
      <div class="perm-rule perm-rule--deny">
        <code class="text-xs"><%= rule %></code>
        <button hx-delete="/api/claude-permissions/deny/<%= encodeURIComponent(rule) %>"
                hx-target="#claude-permissions-panel" hx-swap="outerHTML">×</button>
      </div>
    <% } %>
    <form hx-post="/api/claude-permissions/deny"
          hx-target="#claude-permissions-panel" hx-swap="outerHTML">
      <input name="rule" placeholder="Bash(rm -rf *)" class="input input--sm" />
      <button class="btn btn-xs btn--danger">Add deny</button>
    </form>
  </div>
</div>
```

Add panel to `layout.html` sidebar below the credentials panel.

### CSS additions

```css
.perm-rule {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.25rem 0.5rem;
  border-radius: var(--radius-sm);
  margin-bottom: 0.25rem;
}
.perm-rule--allow { background: color-mix(in srgb, var(--color-success) 10%, transparent); }
.perm-rule--deny  { background: color-mix(in srgb, var(--color-error)   10%, transparent); }
```

### Key files

| File | Action |
|------|--------|
| `src/web/routes/claude-permissions.ts` | New |
| `src/web/views/partials/claude-permissions-panel.html` | New |
| `src/web/app.ts` | Register router |
| `src/web/views/layout.html` | Add panel to sidebar |

---

## Phase 7: Secret Redaction Hook

Even with JIT credentials, a session can echo them to stdout (e.g. `env | grep TOKEN`), which lands in Claude's conversation history JSONL. The redaction hook intercepts every tool result before Claude sees it and scrubs secret-shaped strings.

### How Claude hooks work

Claude Code reads `hooks` from `.claude/settings.json`. A `PostToolUse` hook receives the tool result on stdin as JSON and must write (optionally modified) content to stdout. If the hook writes a `suppressOutput: true` field or modifies `output`, Claude sees the modified version.

Hook stdin schema:
```json
{
  "tool_name": "Bash",
  "tool_input": { "command": "..." },
  "tool_response": { "output": "...", "error": "..." }
}
```

The hook writes modified JSON to stdout. If it exits non-zero, the original result is used unchanged (fail-open, to avoid blocking Claude).

### `src/devguard/redact-hook.ts`

Compiled to `bin/devguard-redact-hook.js` — a standalone script invoked by Claude.

```typescript
import { createInterface } from 'readline'

// Patterns that look like secrets
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Generic high-entropy tokens (40+ base64 chars)
  [/(?<=[A-Za-z0-9_]+=)[A-Za-z0-9+/]{40,}={0,2}/g,           '[REDACTED]'],
  // GitHub PATs — classic and fine-grained
  [/ghp_[A-Za-z0-9]{36}/g,                                     '[REDACTED-GH-PAT]'],
  [/github_pat_[A-Za-z0-9_]{82}/g,                             '[REDACTED-GH-PAT]'],
  // Azure SP client secrets (GUIDs with hyphens, common format)
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[REDACTED-UUID]'],
  // Env-var assignments where value looks secret
  [/((?:SECRET|TOKEN|PAT|PASSWORD|KEY|CREDENTIAL)s?\s*=\s*)\S+/gi, '$1[REDACTED]'],
  // Azure DevOps PATs (52-char base64)
  [/[A-Za-z0-9]{52}/g,                                          '[REDACTED]'],
]

function redact(text: string): string {
  let out = text
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement)
  }
  return out
}

async function main() {
  const chunks: string[] = []
  for await (const line of createInterface({ input: process.stdin })) {
    chunks.push(line)
  }
  const raw = chunks.join('\n')

  let payload: any
  try {
    payload = JSON.parse(raw)
  } catch {
    // Not JSON — pass through
    process.stdout.write(raw)
    process.exit(0)
  }

  if (payload?.tool_response?.output) {
    payload.tool_response.output = redact(payload.tool_response.output)
  }
  if (payload?.tool_response?.error) {
    payload.tool_response.error = redact(payload.tool_response.error)
  }

  process.stdout.write(JSON.stringify(payload))
  process.exit(0)
}

main()
```

### Hook registration

The devguard CLI's `init` command (and `scaffold`) writes/merges this into the project's `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "node /path/to/bin/devguard-redact-hook.js" }]
      },
      {
        "matcher": "Write",
        "hooks": [{ "type": "command", "command": "node /path/to/bin/devguard-redact-hook.js" }]
      }
    ]
  }
}
```

Path is resolved at `devguard init` time to the absolute path of the installed binary (via `process.execPath` + relative resolution, or `which devguard-redact-hook`).

Alternatively, the orcha dashboard's Phase 6 permissions panel includes a **"Enable secret redaction hook"** toggle that writes this config automatically.

### History file scrubbing (`devguard scrub-history`)

An additional subcommand for retroactive cleanup. Claude history lives at:
```
~/.claude/projects/<encoded-path>/*.jsonl
```

```typescript
// src/devguard/scrub-history.ts
export async function scrubHistory(projectPath: string): Promise<{ filesScanned: number; redactionsApplied: number }>
```

- Encodes `projectPath` to the Claude project dir name (replace `/` with `-`, prepend `~/.claude/projects/`)
- Reads each `.jsonl` line, parses JSON, applies `redact()` to all string fields recursively
- Writes back atomically (write to `.tmp`, rename)
- Reports counts

`devguard scrub-history [path]` — defaults to cwd. Confirms before writing.

### What it does NOT do

- Does not redact from the Claude server side (that's Anthropic's domain)
- Does not prevent secrets appearing in the PTY terminal output visible to the user
- UUID pattern will over-redact (subscription IDs etc.) — acceptable tradeoff, users can tune patterns via `.devguard.yaml`

### Tunable patterns in `.devguard.yaml`

```yaml
redaction:
  extra_patterns:
    - pattern: "mysecretvalue"
      replacement: "[REDACTED-CUSTOM]"
  disable_patterns:
    - "uuid"   # turn off UUID redaction if too aggressive
```

### Key files

| File | Action |
|------|--------|
| `src/devguard/redact-hook.ts` | New |
| `src/devguard/scrub-history.ts` | New |
| `src/devguard/cli.ts` | Add `scrub-history` subcommand, hook registration in `init` |
| `bin/devguard-redact-hook.js` | New entrypoint |
| `package.json` | Add bin entry for `devguard-redact-hook` |

---

## Critical Files to Modify

| File | Change |
|------|--------|
| `package.json` | Add bin entries, add deps (`@azure/identity`, `@azure/arm-authorization`, `@microsoft/microsoft-graph-client`) |
| `src/db/index.ts` | Export `credentialStore` |
| `src/web/app.ts` | Register credentials + claude-permissions routers |
| `src/web/routes/sessions.ts` | Pass profiles to new-form, provision on create, auto-revoke |
| `src/terminal/session-manager.ts` | Revoke credentials on session exit |
| `src/terminal/cleanup-service.ts` | Add expired credential cleanup phase |
| `src/web/views/partials/session-card.html` | Add credential strip |
| `src/web/views/partials/new-session-form.html` | Add profile dropdown |
| `src/web/views/layout.html` | Add credentials + permissions panels to sidebar |

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
11. `src/web/routes/claude-permissions.ts` + permissions panel partial
12. `src/devguard/redact-hook.ts` + `scrub-history.ts` + `bin/devguard-redact-hook.js`

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
7. **Permissions editor**: Add an allow rule via dashboard → `.claude/settings.json` updated → add deny rule → deny overrides allow. Remove rules. File round-trips cleanly.
8. **Redaction hook**: Run `echo "GH_TOKEN=ghp_abc123abc123abc123abc123abc123abc123"` in a Claude session → history JSONL contains `[REDACTED-GH-PAT]` not the token. UUID redaction fires on `az` output containing subscription IDs.
9. **Scrub history**: `devguard scrub-history` on a history dir containing known test secrets → reports redaction count → re-running reports 0 (idempotent).

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
- Bootstrap auth never enters the session env — only the scoped JIT tokens do
- In the container, `az login` is NOT used — managed identity is the bootstrap for Azure
- `DefaultAzureCredential` makes azure.ts work identically on dev machine (az CLI) and in container (managed identity)
- Azure SP provisioning requires the managed identity to have role assignment rights. If blocked by tenant policy, the azure provider degrades gracefully and GitHub/DevOps still work
- The `Application.ReadWrite.OwnedBy` AAD Graph permission cannot be set via Bicep — must be done once via `az ad app permission add` or the portal by a Global Admin / Application Admin
- `User Access Administrator` at the resource group scope is the minimum RBAC grant needed for role assignment; `Owner` also works
- GitHub bootstrap token needs `manage:personal_access_tokens` scope (not present on all classic PATs — must be explicitly granted when creating the token)
- DevOps bootstrap PAT needs "Token Administration" scope enabled
- `.devguard/session.env` and `~/.devguard/sessions.json` must be gitignored
- Redaction hook is fail-open (exit non-zero = original output used) to avoid blocking Claude on hook bugs
- UUID redaction is intentionally aggressive; subscription IDs etc. will be redacted — acceptable for security-first contexts, tunable via `.devguard.yaml`
- The permissions editor writes `.claude/settings.json` in the orcha project root (where orcha itself runs), not in individual session worktrees
