-- Persistent HTTP session store for express-session (OIDC auth).
-- Replaces the default in-memory store so sessions survive container restarts
-- and work correctly when scaled to multiple instances.
CREATE TABLE IF NOT EXISTS web_sessions (
  sid     TEXT    PRIMARY KEY,
  data    TEXT    NOT NULL,
  expires INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_web_sessions_expires ON web_sessions (expires);
