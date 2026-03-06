import type { GlobalSettingsStore } from '../../db/global-settings-store.js';

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

const DB_KEY = 'claude_settings';

export function readSettingsFromDb(store: GlobalSettingsStore): ClaudeSettings {
  const raw = store.get(DB_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as ClaudeSettings;
  } catch {
    return {};
  }
}

export function writeSettingsToDb(store: GlobalSettingsStore, settings: ClaudeSettings): void {
  store.set(DB_KEY, JSON.stringify(settings));
}

// Simple single-writer queue to avoid concurrent writes
let _writeQueue = Promise.resolve();

export function enqueueWrite(fn: () => void): Promise<void> {
  _writeQueue = _writeQueue.then(() => {
    fn();
  });
  return _writeQueue;
}
