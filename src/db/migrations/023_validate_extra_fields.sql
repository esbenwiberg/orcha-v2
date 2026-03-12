-- Add health_port, ready_delay, and env to repo and preset validation config
ALTER TABLE repos ADD COLUMN validate_health_port INTEGER;
ALTER TABLE repos ADD COLUMN validate_ready_delay INTEGER;
ALTER TABLE repos ADD COLUMN validate_env_json TEXT;

ALTER TABLE presets ADD COLUMN validate_health_port INTEGER;
ALTER TABLE presets ADD COLUMN validate_ready_delay INTEGER;
ALTER TABLE presets ADD COLUMN validate_env_json TEXT;
