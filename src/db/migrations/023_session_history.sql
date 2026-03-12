ALTER TABLE sessions ADD COLUMN history_captured_at TEXT;
ALTER TABLE sessions ADD COLUMN history_size_bytes INTEGER;
ALTER TABLE sessions ADD COLUMN history_message_count INTEGER;
