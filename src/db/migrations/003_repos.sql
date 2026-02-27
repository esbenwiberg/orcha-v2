CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL DEFAULT 'other',
  display_name TEXT NOT NULL,
  bare_path TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE presets ADD COLUMN repo_id TEXT REFERENCES repos(id) ON DELETE SET NULL;
