import type { ModelConfig } from './types.js';

/**
 * Sentinel value indicating a key should be deleted from the environment
 * rather than set. Used for `max` provider to unset ANTHROPIC_API_KEY.
 */
export const ENV_DELETE = '__ORCHA_DELETE__';

/**
 * Build env vars for a model config. Returns a record of key-value pairs
 * to merge into the PTY environment. Values set to ENV_DELETE should be
 * removed from the env rather than set.
 */
export function buildModelEnv(config: ModelConfig): Record<string, string> {
  const env: Record<string, string> = {};

  switch (config.provider) {
    case 'max':
      // Unset any ambient API key so Claude Code uses OAuth / Max plan
      env['ANTHROPIC_API_KEY'] = ENV_DELETE;
      break;

    case 'anthropic':
      if (config.apiKey) env['ANTHROPIC_API_KEY'] = config.apiKey;
      break;

    case 'foundry':
      env['CLAUDE_CODE_USE_FOUNDRY'] = '1';
      if (config.foundryResource) env['ANTHROPIC_FOUNDRY_RESOURCE'] = config.foundryResource;
      if (config.baseUrl) env['ANTHROPIC_FOUNDRY_BASE_URL'] = config.baseUrl;
      if (config.apiKey) env['ANTHROPIC_FOUNDRY_API_KEY'] = config.apiKey;
      break;

    case 'local':
      if (config.baseUrl) env['ANTHROPIC_BASE_URL'] = config.baseUrl;
      env['ANTHROPIC_API_KEY'] = '';
      env['ANTHROPIC_AUTH_TOKEN'] = 'local';
      break;

    case 'custom':
      if (config.extraEnv) Object.assign(env, config.extraEnv);
      break;
  }

  // Model override applies to all providers
  if (config.modelId) env['ANTHROPIC_MODEL'] = config.modelId;

  return env;
}
