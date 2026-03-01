-- Repo-level validation defaults
ALTER TABLE repos ADD COLUMN validate_mode TEXT;
ALTER TABLE repos ADD COLUMN validate_build TEXT;
ALTER TABLE repos ADD COLUMN validate_start TEXT;
ALTER TABLE repos ADD COLUMN validate_health TEXT;
ALTER TABLE repos ADD COLUMN validate_compose_file TEXT;
ALTER TABLE repos ADD COLUMN validate_timeout INTEGER DEFAULT 300;

-- Preset-level validation overrides (all nullable = "use repo default")
ALTER TABLE presets ADD COLUMN validate_mode TEXT;
ALTER TABLE presets ADD COLUMN validate_build TEXT;
ALTER TABLE presets ADD COLUMN validate_start TEXT;
ALTER TABLE presets ADD COLUMN validate_health TEXT;
ALTER TABLE presets ADD COLUMN validate_compose_file TEXT;
ALTER TABLE presets ADD COLUMN validate_timeout INTEGER;
