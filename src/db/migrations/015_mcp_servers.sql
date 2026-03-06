CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  url TEXT,
  command TEXT,
  args TEXT,
  headers TEXT,
  created_at TEXT NOT NULL
);

ALTER TABLE presets ADD COLUMN mcp_server_ids TEXT;
