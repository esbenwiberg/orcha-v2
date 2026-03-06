ALTER TABLE sessions ADD COLUMN repo_root TEXT;
UPDATE sessions SET repo_root = json_extract(config_json, '$.repoRoot');
