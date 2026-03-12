/**
 * Environment variable allowlist for validation child processes.
 *
 * Validation processes (serve, docker compose, build steps) must NOT inherit
 * Orcha's host secrets (AUTH_TOKEN, SESSION_SECRET, ANTHROPIC_API_KEY, etc.).
 * Instead of spreading process.env and hoping we blocked everything dangerous,
 * we only pass explicitly safe variables.
 */

/** Env vars safe to pass to any validation child process. */
const VALIDATION_ENV_ALLOWLIST = new Set([
  // System essentials
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  'HOSTNAME',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',

  // Node.js runtime
  'NODE_ENV',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NPM_CONFIG_REGISTRY',
  'COREPACK_ENABLE_STRICT',

  // Build/CI conventions
  'CI',
  'FORCE_COLOR',
  'NO_COLOR',
  'TERM_PROGRAM',
]);

/** Additional env vars needed by docker CLI (DOCKER_HOST, TLS certs). */
const DOCKER_CLI_VARS = [
  'DOCKER_HOST',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
  'DOCKER_CONTEXT',
];

/**
 * Build a sanitized env for validation child processes.
 * Only passes allowlisted system vars + any explicit extras.
 */
export function sanitizeEnvForValidation(
  extra?: Record<string, string>,
): Record<string, string> {
  const clean: Record<string, string> = {};

  for (const key of VALIDATION_ENV_ALLOWLIST) {
    const val = process.env[key];
    if (val !== undefined) clean[key] = val;
  }

  if (extra) Object.assign(clean, extra);

  return clean;
}

/**
 * Build a sanitized env for docker CLI processes (compose up/down/logs).
 * Includes everything from sanitizeEnvForValidation plus Docker connection vars.
 */
export function sanitizeEnvForDocker(
  extra?: Record<string, string>,
): Record<string, string> {
  const clean = sanitizeEnvForValidation(extra);

  for (const key of DOCKER_CLI_VARS) {
    const val = process.env[key];
    if (val !== undefined) clean[key] = val;
  }

  return clean;
}
