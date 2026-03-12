# Multi-CLI Support: Codex & Copilot CLI

> **Scope**: Interactive PTY sessions only. The task pipeline (investigate / enrich / execute) stays Claude Code-only — those depend heavily on `--print --output-format stream-json`, `--allowedTools`, and `--max-turns` which have no equivalents in other CLIs.

## Target CLIs

| | Claude Code | OpenAI Codex | GitHub Copilot CLI |
|---|---|---|---|
| **Binary** | `claude` | `codex` | `copilot` |
| **Install** | `npm i -g @anthropic-ai/claude-code` | `npm i -g @openai/codex` | `npm i -g @github/copilot` |
| **Auth env var** | `ANTHROPIC_API_KEY` | `OPENAI_API_KEY` | `GH_TOKEN` / `GITHUB_TOKEN` |
| **OAuth** | `/login` → Anthropic | N/A (API key only) | `/login` → GitHub |
| **Skip permissions** | `--dangerously-skip-permissions` | `-a full-auto` | Shift+Tab autopilot (no known CLI flag) |
| **Project config** | `CLAUDE.md` | `AGENTS.md` | `AGENTS.md` |
| **Config dir** | `~/.claude/` | `~/.codex/` | `~/.copilot/` |
| **MCP support** | Yes (settings.json) | No | Yes (format TBD) |
| **Hooks** | Yes (PostToolUse) | No | Unknown |
| **Models** | Anthropic only | OpenAI + multi-provider | Claude Sonnet 4.5, GPT-5 |

---

## Current Claude Code Coupling Points

Nine layers of coupling exist in the codebase today:

| # | Layer | Key files |
|---|---|---|
| 1 | Binary name (`claude` hardcoded) | `sessions.ts:631`, `session-manager.ts:436`, `auth-terminal-manager.ts:142` |
| 2 | CLI flags (`--dangerously-skip-permissions`) | `sessions.ts:625` |
| 3 | Env vars (`ANTHROPIC_*`, `CLAUDE_CODE_USE_FOUNDRY`) | `env-builder.ts`, `pty-manager.ts:125` |
| 4 | Config dir (`~/.claude/`) + files (`settings.json`, `.config.json`, `.credentials.json`, `CLAUDE.md`, `skills/`) | `sessions.ts:358-536`, `task-processor.ts:527-630` |
| 5 | PTY output parsing (idle `> `, tool-use `●`, permission `(y)es │ (n)o`) | `claude-patterns.ts`, `status-monitor.ts` |
| 6 | MCP injection (`mcpServers` key in Claude's settings schema) | `sessions.ts:399-408` |
| 7 | Hook system (`PostToolUse` in `settings.json`) | `devguard/` |
| 8 | OAuth flow (`/login`, "Select login method" detection) | `auth-terminal-manager.ts` |
| 9 | Credential capture (`~/.claude/.credentials.json` on exit) | `session-manager.ts:333-347` |

Only layers 1-6 and 8-9 matter for interactive sessions. Layer 7 (hooks/devguard) is Claude-only and doesn't affect session spawn.

---

## Feature Compatibility Matrix

### Tier 1: Works everywhere (no changes needed)

These are CLI-agnostic — they work regardless of what binary is in the PTY:

- PTY session spawn + terminal streaming (xterm.js)
- Git worktree isolation
- Credential provisioning (Azure / GitHub / DevOps PATs → env vars)
- Git config + `.git-credentials` injection
- Debug shells, host shells, deploy commands
- Private feed configs (`.npmrc`, `NuGet.Config`)
- Session reopen (stored command/args replayed)
- PR review (markdown file written to `.orcha/pr-review.md` in worktree)

### Tier 2: Degrades — hide in UI when unsupported

| Feature | Claude | Codex | Copilot | How to handle |
|---|---|---|---|---|
| MCP servers | Full | **No** | Yes (format TBD) | Hide MCP selector for Codex |
| Skills (slash commands) | Full | **No** | **No** | Hide for non-Claude |
| OAuth auth terminal | Full | **No** | Possible | Only show for CLIs with `supportsOAuth` |
| Web access toggle | Full (maps to `permissions.deny`) | **No** | TBD | Hide for non-Claude |
| Devguard (secret redaction) | Full (PostToolUse hooks) | **No** | **No** | Only activate for Claude sessions |
| Model config dropdown | All Anthropic providers | Just `OPENAI_API_KEY` | Just `GH_TOKEN` | Filter model configs by CLI tool |
| Status badges | Full (known patterns) | Simplified | Simplified | Fallback to timer-based idle detection |

### Tier 3: Needs rethinking

| Feature | Issue | Proposed solution |
|---|---|---|
| Agent instructions (CLAUDE.md / Soul.md) | Different filenames per CLI | Rename UI to "Agent Instructions". Write as `~/.claude/CLAUDE.md` for Claude, `AGENTS.md` in worktree root for Codex/Copilot. Same content, different destinations. |
| Skip permissions toggle | Copilot uses Shift+Tab keypress, not a CLI flag | For Copilot: send escape sequence to PTY after startup. Or: wait for a flag to exist. For now, hide toggle and document as manual. |
| Onboarding suppression | Each CLI has different first-run prompts | Per-CLI home setup must write the right config to skip onboarding. Needs empirical testing for Codex and Copilot. |
| Settings.json schema | Each CLI reads different config format | Per-CLI `setupHome()` writes the appropriate config files |

---

## Implementation Plan

### Phase 1: Abstraction (Claude stays the only option, zero behavior change)

**Goal**: Extract the CLI-specific logic into a provider interface so adding new CLIs is plug-and-play.

#### 1.1 Define `CliTool` types

New file: `src/cli-tools/types.ts`

```typescript
export type CliToolId = 'claude' | 'codex' | 'copilot';

export interface CliCapabilities {
  supportsMcp: boolean;
  supportsSkills: boolean;
  supportsPermissionsDeny: boolean;  // web access toggle
  supportsSkipPermissions: boolean;  // CLI flag for auto-approve
  supportsOAuth: boolean;
  supportsHooks: boolean;            // devguard
}

export interface CliPatterns {
  idle: RegExp;
  toolUse: RegExp;
  thinking: RegExp;
  complete: RegExp;
  error: RegExp;
  needsConfirmation: RegExp;
  needsPermission: RegExp;
}

export interface CliToolConfig {
  id: CliToolId;
  label: string;                     // "Claude Code", "OpenAI Codex", "GitHub Copilot"
  binary: string;                    // "claude", "codex", "copilot"
  configDir: string;                 // ".claude", ".codex", ".copilot"
  instructionsFile: string;          // "CLAUDE.md" or "AGENTS.md"
  instructionsLocation: 'home-config-dir' | 'worktree-root';
  skipPermissionsArgs: string[];     // ["--dangerously-skip-permissions"] or ["-a", "full-auto"]
  capabilities: CliCapabilities;
  patterns: CliPatterns;
}
```

#### 1.2 Create provider implementations

New files:
- `src/cli-tools/claude.ts` — extracts current hardcoded values
- `src/cli-tools/codex.ts`
- `src/cli-tools/copilot.ts`
- `src/cli-tools/index.ts` — registry: `getCliTool(id: CliToolId): CliToolConfig`

#### 1.3 Extract home directory setup

Refactor the big block in `sessions.ts:358-536` into:

```
src/cli-tools/setup-home.ts
  - setupSessionHome(tool: CliToolConfig, homePath: string, opts: HomeSetupOpts): void
```

Per-CLI logic:
- **Claude**: write `~/.claude/settings.json`, `.config.json`, `CLAUDE.md`, skills, `.credentials.json`
- **Codex**: write `~/.codex/` config (format TBD), `AGENTS.md` in worktree
- **Copilot**: write `~/.copilot/lsp-config.json` (if needed), `AGENTS.md` in worktree

MCP injection becomes conditional: only called when `capabilities.supportsMcp === true`.

#### 1.4 Make StatusMonitor pattern-aware per session

Current: `StatusMonitor` imports `CLAUDE_PATTERNS` globally.

Change: `watch(sessionId, terminal, patterns: CliPatterns)` — pass patterns from the CLI tool config. Rename `claude-patterns.ts` → move patterns into each CLI tool provider file.

#### 1.5 Wire CliToolId through the data model

- Add `cliTool?: CliToolId` to `SessionConfig` in `src/domain/types.ts` (defaults to `'claude'`)
- Add `cli_tool TEXT DEFAULT 'claude'` to `presets` table (new migration)
- Session spawn reads `cliTool` from form, resolves to `CliToolConfig`, uses it throughout

#### 1.6 Update env-builder

`buildModelEnv()` currently only knows Anthropic env vars. Two options:

- **Option A**: Add a `cliTool` parameter and branch internally (quick but grows messily)
- **Option B**: Model configs get a `cliTool` affinity — an Anthropic API key config is only selectable for Claude sessions, an OpenAI key config for Codex, etc. The `custom` provider type stays universal via `extraEnv`.

**Recommendation**: Option B. Model configs already have a `provider` field. Add a `compatibleClis` derived property. The session form filters the model config dropdown based on selected CLI tool.

#### 1.7 UI changes

- Session form: add CLI tool selector (radio buttons or dropdown) above the existing fields
- Conditional rendering: hide MCP servers, skills, web access, skip permissions based on `capabilities`
- Session card: small badge showing CLI tool (`CC` / `CX` / `CP`)
- Settings page: rename "CLAUDE.md" editor to "Agent Instructions" (content serves all CLIs)
- Startup banner: `Starting claude...` → `Starting ${tool.label}...`

### Phase 2: Codex Support

**Prerequisites**: Phase 1 complete, `codex` binary installed in container.

1. **Capture PTY patterns** — run Codex interactively, record:
   - Idle prompt format
   - Tool-use output indicators
   - Thinking/processing indicators
   - Permission prompt format (in non-full-auto mode)
   - Task complete indicator
   - Error patterns

2. **Implement `codex.ts` provider** — fill in patterns and config

3. **Home setup for Codex** — research `~/.codex/` config format:
   - Onboarding suppression
   - Default model override
   - Any project-level settings

4. **Test**: create a Codex session, verify status monitoring, verify no broken UI elements

5. **Dockerfile**: add `npm i -g @openai/codex` to container build

### Phase 3: Copilot CLI Support

**Prerequisites**: Phase 1 complete, `copilot` binary installed in container.

1. **Capture PTY patterns** — same as Codex

2. **Research MCP injection** — figure out how to pre-configure custom MCP servers:
   - Is there a config file format?
   - Can it be set via environment?
   - Or does it require interactive `/mcp` setup?

3. **Implement autopilot activation** — if no CLI flag exists:
   - Option A: Send Shift+Tab escape sequence to PTY after startup delay
   - Option B: Wait for GitHub to add a flag
   - Option C: Skip auto-approve for Copilot initially

4. **OAuth flow** — Copilot uses `/login` like Claude. Research:
   - Does it show a "Select login method" prompt?
   - Can `GH_TOKEN` env var bypass OAuth entirely?
   - What does `.copilot/` credentials file look like?

5. **Home setup for Copilot** — `~/.copilot/lsp-config.json` and any other config

6. **Dockerfile**: add `npm i -g @github/copilot`

---

## Open Questions (Need Empirical Testing)

| # | Question | How to answer |
|---|---|---|
| 1 | What are Codex's PTY output patterns (idle, tool-use, permission prompts)? | Run `codex` in a PTY, capture raw output |
| 2 | What are Copilot CLI's PTY output patterns? | Same — run `copilot`, capture output |
| 3 | Can Copilot MCP servers be pre-configured in a file? | Check `~/.copilot/` after manual `/mcp` setup |
| 4 | Does Copilot have a CLI flag for autopilot mode? | Check `copilot --help` or source |
| 5 | What does `~/.codex/` config look like? How to suppress onboarding? | Run Codex, inspect written files |
| 6 | Does Copilot respect `GH_TOKEN` for auth without OAuth? | Test with PAT in env |
| 7 | Can Copilot's model be overridden via env var or config? | Test `/model` behavior + config files |

---

## Files Changed (Estimated)

### New files
- `src/cli-tools/types.ts` — CliToolConfig, CliCapabilities, CliPatterns interfaces
- `src/cli-tools/claude.ts` — Claude Code provider config
- `src/cli-tools/codex.ts` — OpenAI Codex provider config
- `src/cli-tools/copilot.ts` — GitHub Copilot CLI provider config
- `src/cli-tools/index.ts` — registry / lookup
- `src/cli-tools/setup-home.ts` — per-CLI home directory setup (extracted from sessions.ts)
- `src/db/migrations/007-cli-tool.sql` — add `cli_tool` column to presets

### Modified files
- `src/domain/types.ts` — add `cliTool` to `SessionConfig`
- `src/web/routes/sessions.ts` — use CliToolConfig for spawn, home setup, MCP injection
- `src/terminal/session-manager.ts` — dynamic command/args, credential capture per CLI
- `src/terminal/status-monitor.ts` — accept patterns per session
- `src/terminal/claude-patterns.ts` — delete (patterns move into provider files)
- `src/model-config/env-builder.ts` — CLI-aware env building (or filter in UI)
- `src/terminal/auth-terminal-manager.ts` — per-CLI OAuth flow branching
- `src/web/views/partials/new-session-form.eta` — CLI tool selector, conditional fields
- `src/web/views/partials/session-card.eta` — CLI tool badge
- `src/web/views/pages/settings.eta` — rename CLAUDE.md editor to "Agent Instructions"
- `src/web/routes/presets.ts` — persist `cliTool` on preset
- `src/web/routes/claude-files.ts` — support writing AGENTS.md to worktree root
- `src/sandbox/sandbox-command.ts` — dynamic config dir path for landlock RW

### Untouched (task pipeline — Claude only)
- `src/tasks/spawn-claude.ts`
- `src/tasks/investigate.ts`
- `src/tasks/enrich.ts`
- `src/tasks/execute.ts`
- `src/tasks/task-processor.ts` (task home setup stays Claude-hardcoded)
- `src/devguard/*`
