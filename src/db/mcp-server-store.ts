import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

export interface McpServer {
  id: string;
  name: string;
  type: string;
  url: string | null;
  command: string | null;
  args: string[] | null;
  headers: Record<string, string> | null;
  createdAt: Date;
}

export interface CreateMcpServerInput {
  name: string;
  type: string;
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
}

/** MCP server entry in the format Claude Code expects in settings.json. */
export interface McpSettingsEntry {
  type: string;
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
}

export class McpServerStore {
  #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  #rowToServer(row: Record<string, unknown>): McpServer {
    return {
      id: row['id'] as string,
      name: row['name'] as string,
      type: row['type'] as string,
      url: (row['url'] as string | null) ?? null,
      command: (row['command'] as string | null) ?? null,
      args: row['args'] ? (JSON.parse(row['args'] as string) as string[]) : null,
      headers: row['headers'] ? (JSON.parse(row['headers'] as string) as Record<string, string>) : null,
      createdAt: new Date(row['created_at'] as string),
    };
  }

  listServers(): McpServer[] {
    const rows = this.#db
      .prepare('SELECT * FROM mcp_servers ORDER BY created_at ASC')
      .all() as Record<string, unknown>[];
    return rows.map((row) => this.#rowToServer(row));
  }

  getServer(id: string): McpServer | undefined {
    const row = this.#db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return undefined;
    return this.#rowToServer(row);
  }

  getServerByName(name: string): McpServer | undefined {
    const row = this.#db.prepare('SELECT * FROM mcp_servers WHERE name = ?').get(name) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return undefined;
    return this.#rowToServer(row);
  }

  createServer(input: CreateMcpServerInput): McpServer {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.#db
      .prepare(
        `INSERT INTO mcp_servers (id, name, type, url, command, args, headers, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.type,
        input.url ?? null,
        input.command ?? null,
        input.args ? JSON.stringify(input.args) : null,
        input.headers ? JSON.stringify(input.headers) : null,
        now,
      );

    return this.getServer(id)!;
  }

  deleteServer(id: string): void {
    this.#db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
  }

  /** Strip wrapping quotes from header keys/values — defends against corrupted DB data. */
  static #cleanHeaders(headers: Record<string, string>): Record<string, string> {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      const key = k.replace(/^["'\s]+|["'\s,]+$/g, '');
      const val = typeof v === 'string' ? v.replace(/^["'\s]+|["'\s,]+$/g, '') : v;
      if (key) clean[key] = val;
    }
    return clean;
  }

  /** Get servers by a list of IDs, returning them as Claude settings.json mcpServers entries. */
  getSettingsEntries(ids: string[]): Record<string, McpSettingsEntry> {
    if (ids.length === 0) return {};

    const servers = this.listServers().filter((s) => ids.includes(s.id));
    const entries: Record<string, McpSettingsEntry> = {};

    for (const server of servers) {
      // Remap legacy "command" type to "stdio" (Claude Code's expected value)
      const type = server.type === 'command' ? 'stdio' : server.type;
      const entry: McpSettingsEntry = { type };
      if (server.url !== null) entry.url = server.url;
      if (server.command !== null) entry.command = server.command;
      if (server.args !== null) entry.args = server.args;
      if (server.headers !== null) entry.headers = McpServerStore.#cleanHeaders(server.headers);
      entries[server.name] = entry;
    }

    return entries;
  }
}
