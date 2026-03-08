CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  display_id      INTEGER NOT NULL UNIQUE,
  repo_id         TEXT NOT NULL REFERENCES repos(id),
  title           TEXT NOT NULL,
  description     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft',

  -- Toggles
  auto_enrich     INTEGER NOT NULL DEFAULT 0,
  self_validate   INTEGER NOT NULL DEFAULT 0,
  mcp_server_ids  TEXT,
  credential_profile_id TEXT NOT NULL DEFAULT '',
  model_config_id TEXT NOT NULL DEFAULT '',

  -- Investigation
  investigation_rating  TEXT,
  investigation_result  TEXT,
  investigated_at       TEXT,

  -- Enrichment
  enriched_description  TEXT,
  enrichment_result     TEXT,
  enriched_at           TEXT,

  -- Execution
  session_id      TEXT REFERENCES sessions(id),
  branch          TEXT,
  pr_url          TEXT,
  preview_url     TEXT,

  -- Lifecycle
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at    TEXT,
  error_message   TEXT
);

CREATE TABLE IF NOT EXISTS task_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_status     TEXT,
  to_status       TEXT NOT NULL,
  occurred_at     TEXT NOT NULL DEFAULT (datetime('now')),
  note            TEXT
);

CREATE TABLE IF NOT EXISTS task_transcript (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  phase           TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  event_type      TEXT NOT NULL,
  data            TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_task_transcript_task_phase ON task_transcript(task_id, phase, seq);
