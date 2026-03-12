import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

export interface ValidationConfig {
  mode: 'serve' | 'docker';
  build?: string;
  start?: string;
  health?: string;
  healthPort?: number;
  composeFile?: string;
  timeout: number;
  readyDelay: number;
  env?: Record<string, string>;
}

interface FileConfig {
  mode?: string;
  build?: string;
  start?: string;
  health?: string;
  health_port?: number;
  compose_file?: string;
  timeout?: number;
  ready_delay?: number;
  env?: Record<string, string>;
}

interface DbFields {
  validateMode?: string | null;
  validateBuild?: string | null;
  validateStart?: string | null;
  validateHealth?: string | null;
  validateComposeFile?: string | null;
  validateTimeout?: number | null;
}

interface AgentOverrides {
  mode?: string;
  build?: string;
  start?: string;
  health?: string;
  health_port?: number;
  compose_file?: string;
  timeout?: number;
  ready_delay?: number;
  env?: Record<string, string>;
}

/**
 * Resolve validation config from layered sources.
 * Priority (later wins): .orcha/validate.yml < repo DB fields < preset DB fields < agent overrides
 */
export function resolveConfig(
  worktreePath: string,
  repoFields?: DbFields,
  presetFields?: DbFields,
  agentOverrides?: AgentOverrides,
): ValidationConfig | undefined {
  // Layer 1: Read .orcha/validate.yml from worktree
  let fileConfig: FileConfig = {};
  const configPath = join(worktreePath, '.orcha', 'validate.yml');
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf8');
      const parsed = yaml.load(raw);
      if (parsed && typeof parsed === 'object') {
        fileConfig = parsed as FileConfig;
      }
    } catch {
      // Ignore parse errors — fall through to DB fields
    }
  }

  // Layer 2: Merge repo DB fields (fill gaps, don't override file)
  const merged: Record<string, unknown> = {};
  merged.mode = fileConfig.mode ?? repoFields?.validateMode ?? undefined;
  merged.build = fileConfig.build ?? repoFields?.validateBuild ?? undefined;
  merged.start = fileConfig.start ?? repoFields?.validateStart ?? undefined;
  merged.health = fileConfig.health ?? repoFields?.validateHealth ?? undefined;
  merged.healthPort = fileConfig.health_port ?? undefined;
  merged.composeFile = fileConfig.compose_file ?? repoFields?.validateComposeFile ?? undefined;
  merged.timeout = fileConfig.timeout ?? repoFields?.validateTimeout ?? undefined;
  merged.readyDelay = fileConfig.ready_delay ?? undefined;
  merged.env = fileConfig.env ?? undefined;

  // Layer 3: Preset overrides repo
  if (presetFields) {
    if (presetFields.validateMode) merged.mode = presetFields.validateMode;
    if (presetFields.validateBuild) merged.build = presetFields.validateBuild;
    if (presetFields.validateStart) merged.start = presetFields.validateStart;
    if (presetFields.validateHealth) merged.health = presetFields.validateHealth;
    if (presetFields.validateComposeFile) merged.composeFile = presetFields.validateComposeFile;
    if (presetFields.validateTimeout != null) merged.timeout = presetFields.validateTimeout;
  }

  // Layer 4: Agent tool params override everything
  if (agentOverrides) {
    if (agentOverrides.mode) merged.mode = agentOverrides.mode;
    if (agentOverrides.build) merged.build = agentOverrides.build;
    if (agentOverrides.start) merged.start = agentOverrides.start;
    if (agentOverrides.health) merged.health = agentOverrides.health;
    if (agentOverrides.health_port != null) merged.healthPort = agentOverrides.health_port;
    if (agentOverrides.compose_file) merged.composeFile = agentOverrides.compose_file;
    if (agentOverrides.timeout != null) merged.timeout = agentOverrides.timeout;
    if (agentOverrides.ready_delay != null) merged.readyDelay = agentOverrides.ready_delay;
    if (agentOverrides.env) {
      merged.env = { ...(merged.env as Record<string, string> | undefined), ...agentOverrides.env };
    }
  }

  // Mode is required
  if (merged.mode !== 'serve' && merged.mode !== 'docker') {
    return undefined;
  }

  return {
    mode: merged.mode,
    ...(merged.build ? { build: merged.build as string } : {}),
    ...(merged.start ? { start: merged.start as string } : {}),
    ...(merged.health ? { health: merged.health as string } : {}),
    ...(typeof merged.healthPort === 'number' ? { healthPort: merged.healthPort } : {}),
    ...(merged.composeFile ? { composeFile: merged.composeFile as string } : {}),
    timeout: typeof merged.timeout === 'number' ? merged.timeout : 300,
    readyDelay: typeof merged.readyDelay === 'number' ? merged.readyDelay : 0,
    ...(merged.env ? { env: merged.env as Record<string, string> } : {}),
  };
}
