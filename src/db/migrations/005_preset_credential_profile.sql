-- Add credential_profile_id; remove branch, base_path, prompt (repo_id was added in 003)
ALTER TABLE presets ADD COLUMN credential_profile_id TEXT;
ALTER TABLE presets DROP COLUMN branch;
ALTER TABLE presets DROP COLUMN base_path;
ALTER TABLE presets DROP COLUMN prompt;
