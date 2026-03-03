import fs from 'node:fs';
import path from 'node:path';

export interface ClaudeSettings {
  permissions?: {
    allow?: string[];
    deny?: string[];
  };
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

export interface McpServerEntry {
  type?: string;
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  [key: string]: unknown;
}

export const SETTINGS_PATH = path.resolve('.claude', 'settings.json');

// Simple single-writer queue to avoid concurrent writes
let _writeQueue = Promise.resolve();

export function readSettings(): ClaudeSettings {
  if (!fs.existsSync(SETTINGS_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) as ClaudeSettings;
  } catch {
    return {};
  }
}

export function writeSettings(settings: ClaudeSettings): void {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
}

export function enqueueWrite(fn: () => void): Promise<void> {
  _writeQueue = _writeQueue.then(() => {
    fn();
  });
  return _writeQueue;
}
