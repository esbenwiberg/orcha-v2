CREATE TABLE IF NOT EXISTS credential_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  duration_hours INTEGER NOT NULL DEFAULT 4,
  azure_json TEXT,
  github_json TEXT,
  devops_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_credentials (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id),
  profile_id TEXT REFERENCES credential_profiles(id),
  profile_name TEXT NOT NULL,
  azure_sp_name TEXT,
  azure_app_id TEXT,
  github_pat_id TEXT,
  devops_pat_id TEXT,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_credentials_session_id ON session_credentials(session_id);
CREATE INDEX IF NOT EXISTS idx_session_credentials_expires_at ON session_credentials(expires_at);
