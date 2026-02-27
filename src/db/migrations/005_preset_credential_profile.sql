-- Add repo_id (was missing from 002) and credential_profile_id; remove branch, base_path, prompt
ALTER TABLE presets ADD COLUMN repo_id TEXT;
ALTER TABLE presets ADD COLUMN credential_profile_id TEXT;
ALTER TABLE presets DROP COLUMN branch;
ALTER TABLE presets DROP COLUMN base_path;
ALTER TABLE presets DROP COLUMN prompt;
