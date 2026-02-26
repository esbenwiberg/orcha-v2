CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS instances (id TEXT PRIMARY KEY, repo_root TEXT NOT NULL, registered_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, active_sessions INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, display_id INTEGER NOT NULL UNIQUE, instance_id TEXT NOT NULL REFERENCES instances(id), status TEXT NOT NULL, config_json TEXT NOT NULL, worktree_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, exit_code INTEGER, error_message TEXT);
CREATE INDEX IF NOT EXISTS idx_sessions_instance_id ON sessions(instance_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE TABLE IF NOT EXISTS status_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), from_status TEXT NOT NULL, to_status TEXT NOT NULL, occurred_at TEXT NOT NULL, note TEXT);
CREATE INDEX IF NOT EXISTS idx_status_events_session_id ON status_events(session_id);
