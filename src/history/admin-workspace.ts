import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readSettingsFromDb } from '../web/routes/claude-settings-db.js';
import type { GlobalSettingsStore } from '../db/global-settings-store.js';

export interface AdminWorkspaceResult {
  workspaceDir: string;
  homeDir: string;
}

const CLAUDE_MD_CONTENT = `# History Analysis Workspace

You have read access to captured Claude Code session history files.

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

## Tips

- Use \`cat\` / \`jq\` to inspect individual JSONL files
- Use \`wc -l\` to count messages per file
- Use \`grep\` to search across all history files
- Write scripts in /tmp if you need to process data programmatically
`;

/**
 * Prepare an admin workspace with symlinks to captured history directories.
 * Creates a minimal Claude HOME with trust + onboarding configured.
 */
export function prepareAdminWorkspace(
  dataDir: string,
  globalSettingsStore: GlobalSettingsStore,
  selectedSessionIds?: string[],
): AdminWorkspaceResult {
  const id = randomUUID().slice(0, 12);
  const workspaceDir = `/tmp/orcha-admin-${id}`;
  const adminHomeDir = `/tmp/orcha-admin-home-${id}`;

  mkdirSync(workspaceDir, { recursive: true });

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

  // Write CLAUDE.md into the workspace
  writeFileSync(join(workspaceDir, 'CLAUDE.md'), CLAUDE_MD_CONTENT, 'utf8');

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
