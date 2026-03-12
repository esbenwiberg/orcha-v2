-- Session messaging: channels for scoped collaboration, messages for fire-and-forget + channel chat

CREATE TABLE IF NOT EXISTS message_channels (
    id              TEXT PRIMARY KEY,
    topic           TEXT NOT NULL,
    join_secret     TEXT NOT NULL,
    created_by      TEXT NOT NULL,
    max_exchanges   INTEGER NOT NULL DEFAULT 20,
    exchange_count  INTEGER NOT NULL DEFAULT 0,
    cooldown_ms     INTEGER NOT NULL DEFAULT 5000,
    pty_nudge       INTEGER NOT NULL DEFAULT 1,
    status          TEXT NOT NULL DEFAULT 'open',
    closed_by       TEXT,
    summary         TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at       TEXT,
    expires_at      TEXT
);

CREATE TABLE IF NOT EXISTS channel_members (
    channel_id      TEXT NOT NULL REFERENCES message_channels(id) ON DELETE CASCADE,
    session_id      TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT '',
    joined_at       TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (channel_id, session_id)
);

CREATE TABLE IF NOT EXISTS session_messages (
    id              TEXT PRIMARY KEY,
    channel_id      TEXT REFERENCES message_channels(id) ON DELETE CASCADE,
    from_session    TEXT NOT NULL,
    to_session      TEXT,
    body            TEXT NOT NULL,
    pty_nudge       INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    read_at         TEXT,
    nudged_at       TEXT
);

CREATE INDEX idx_session_messages_to   ON session_messages(to_session, read_at);
CREATE INDEX idx_session_messages_chan  ON session_messages(channel_id, created_at);
