export const CLAUDE_PATTERNS = {
  IDLE_PROMPT: /^\s*>\s*$/m,
  TOOL_USE: /^\s*●\s+\w/m,
  THINKING: /Thinking\.\.\./i,
  TASK_COMPLETE: /Task complete/i,
  ERROR_FATAL: /(?:Error:|error:|ENOENT|EPERM|fatal:)/m,
  /** Classic [y/n] confirmation prompt */
  NEEDS_CONFIRMATION: /\?\s*\[y\/n\]/i,
  /** Claude Code permission prompt: "Allow <tool>? (y)es | (n)o | ..." */
  NEEDS_PERMISSION: /\(y\)es\s*[|│]/i,
} as const;

export type PatternKey = keyof typeof CLAUDE_PATTERNS;
