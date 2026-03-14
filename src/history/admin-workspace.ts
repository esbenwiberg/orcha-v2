import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readSettingsFromDb } from '../web/routes/claude-settings-db.js';
import type { GlobalSettingsStore } from '../db/global-settings-store.js';

export interface AdminWorkspaceResult {
  workspaceDir: string;
  homeDir: string;
}

function buildClaudeMd(orchaApiUrl: string): string {
  return `# History Analysis Workspace

You are an interactive analysis assistant for Claude Code session history.

**On startup:** Browse the \`./history/\` directory to understand what data is available (repos, sessions, sizes), then print a brief summary and wait for the user's instructions. Do NOT exit — this is an interactive session.

You have read access to captured Claude Code session history files.
You can also update Orcha settings via the Orcha API.

## Data Layout

\`history/<sessionId>/<encoded-path>/<conversation>.jsonl\`

Each JSONL file is a Claude Code conversation transcript. Each line is a JSON object representing one message in the conversation.

## JSONL Message Format

Common fields:
- \`type\`: message role — \`"human"\`, \`"assistant"\`, \`"system"\`
- \`message\`: the message object containing \`role\`, \`content\`, \`model\`, \`usage\`, etc.
- \`costUSD\`: cost in US dollars for this turn (when present)
- \`durationMs\`: wall-clock time for this turn
- \`timestamp\`: ISO 8601 timestamp

The \`message.content\` field may contain:
- Plain text
- Tool use blocks (\`type: "tool_use"\`) with \`name\` and \`input\`
- Tool result blocks (\`type: "tool_result"\`)
- Thinking blocks (\`type: "thinking"\`)

## Suggested Analyses

- **Token usage & cost**: Sum \`costUSD\` across turns, break down by session
- **Tool call frequency**: Count tool_use blocks by \`name\` — which tools are used most?
- **Error patterns**: Search for error messages, failed tool results, retries
- **Session duration**: Compare first/last timestamps per file
- **Model usage**: Check \`message.model\` across sessions
- **Code changes**: Look at Edit/Write tool calls to see what files were modified

## Orcha API

Base URL: \`${orchaApiUrl}\`

Use \`curl\` to interact with the Orcha API. All mutation endpoints accept form-encoded bodies unless noted.

### Claude Permissions (settings.json rules)
- \`GET  /api/claude-permissions\` — view current allow/deny rules (returns HTML, parse or just inspect)
- \`POST /api/claude-permissions/allow\` — add allow rule. Body: \`rule=<pattern>\`
- \`DELETE /api/claude-permissions/allow/<url-encoded-rule>\` — remove allow rule
- \`POST /api/claude-permissions/deny\` — add deny rule. Body: \`rule=<pattern>\`
- \`DELETE /api/claude-permissions/deny/<url-encoded-rule>\` — remove deny rule

### Presets
- \`GET  /api/presets\` — list presets
- \`POST /api/presets\` — create preset. Fields: name, repoId, credentialProfileId, modelConfigId
- \`PUT  /api/presets/:id\` — update preset
- \`DELETE /api/presets/:id\` — delete preset

### Repositories
- \`GET  /api/repos\` — list repos
- \`POST /api/repos\` — add repo. Fields: url
- \`PUT  /api/repos/:id\` — update repo settings
- \`DELETE /api/repos/:id\` — delete repo

### Model Configs
- \`GET  /api/model-configs\` — list model configurations
- \`POST /api/model-configs\` — create config. Fields: name, provider, apiKey, baseUrl, modelId
- \`PUT  /api/model-configs/:id\` — update config
- \`DELETE /api/model-configs/:id\` — delete config

### Skills
- \`GET  /api/skills\` — list skills
- \`POST /api/skills\` — create/update skill. Fields: name, content
- \`DELETE /api/skills/:name\` — delete skill

### MCP Servers
- \`GET  /api/mcp-servers\` — list MCP servers
- \`POST /api/mcp-servers\` — add server. Fields: name, type (url|sse|http|stdio), url, command, args
- \`DELETE /api/mcp-servers/:id\` — remove server

### Task Settings
- \`POST /api/task-settings/max-concurrent\` — set max concurrent tasks. Fields: maxConcurrent (1-10)

### System
- \`POST /api/system/clean/logs\` — delete logs older than 7 days
- \`POST /api/system/clean/worktrees\` — remove worktrees for stopped sessions

**Note:** Most mutation endpoints return empty 200 on success. Errors return 422 with HTML.

## Tips

- Use \`cat\` / \`jq\` to inspect individual JSONL files
- Use \`wc -l\` to count messages per file
- Use \`grep\` to search across all history files
- Write scripts in /tmp if you need to process data programmatically
- Use \`curl -s ${orchaApiUrl}/api/...\` to read or update Orcha settings based on your findings
`;
}

/**
 * Prepare an admin workspace with symlinks to captured history directories.
 * Creates a minimal Claude HOME with trust + onboarding configured.
 */
export function prepareAdminWorkspace(
  dataDir: string,
  globalSettingsStore: GlobalSettingsStore,
  orchaHost: string,
  selectedSessionIds?: string[],
): AdminWorkspaceResult {
  const id = randomUUID().slice(0, 12);
  const workspaceDir = `/tmp/orcha-admin-${id}`;
  const adminHomeDir = `/tmp/orcha-admin-home-${id}`;

  mkdirSync(workspaceDir, { recursive: true });

  // Claude Code requires a git repo — init a bare one so it doesn't hang
  execSync('git init', { cwd: workspaceDir, stdio: 'ignore' });

  // Link history directories into workspace/history/
  const historyBaseDir = join(dataDir, 'session-history');
  const workspaceHistoryDir = join(workspaceDir, 'history');
  mkdirSync(workspaceHistoryDir, { recursive: true });

  if (existsSync(historyBaseDir)) {
    const sessionDirs = selectedSessionIds ?? readdirSync(historyBaseDir);
    for (const sessionId of sessionDirs) {
      const srcDir = join(historyBaseDir, sessionId);
      try {
        const stat = statSync(srcDir);
        if (!stat.isDirectory()) continue;
        // Use symlink for efficiency — admin session has read-only intent
        symlinkSync(srcDir, join(workspaceHistoryDir, sessionId));
      } catch {
        // Source doesn't exist or symlink failed — skip
      }
    }
  }

  // Write CLAUDE.md into the workspace (includes Orcha API reference)
  writeFileSync(join(workspaceDir, 'CLAUDE.md'), buildClaudeMd(orchaHost), 'utf8');

  // Set up admin HOME with Claude config
  const claudeDir = join(adminHomeDir, '.claude');
  mkdirSync(claudeDir, { recursive: true });

  // Settings.json — permissions + theme
  const settings: Record<string, unknown> = readSettingsFromDb(globalSettingsStore);
  if (!('theme' in settings)) settings['theme'] = 'dark';
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(settings), 'utf8');

  // .config.json — trust the workspace, skip onboarding
  const claudeConfig: Record<string, unknown> = {
    hasCompletedOnboarding: true,
    theme: 'dark',
    projects: {
      [workspaceDir]: {
        hasTrustDialogAccepted: true,
        allowedTools: [],
      },
    },
  };
  writeFileSync(join(claudeDir, '.config.json'), JSON.stringify(claudeConfig), 'utf8');

  // Copy host .gitconfig if present
  const srcGitconfig = join(homedir(), '.gitconfig');
  if (existsSync(srcGitconfig)) {
    try {
      writeFileSync(join(adminHomeDir, '.gitconfig'), readFileSync(srcGitconfig));
    } catch { /* ignore */ }
  }

  return { workspaceDir, homeDir: adminHomeDir };
}
