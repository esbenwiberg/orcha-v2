export interface DeployConfig {
  subscriptionId: string;
  resourceGroup: string;
  acrName: string;
  containerAppName: string;
  sourceRepo: string;
  sourceBranch: string;
  githubPat?: string;
  healthUrl?: string;
}

const REQUIRED_VARS = [
  'DEPLOY_SUBSCRIPTION_ID',
  'DEPLOY_RESOURCE_GROUP',
  'DEPLOY_ACR_NAME',
  'DEPLOY_CONTAINER_APP_NAME',
  'DEPLOY_SOURCE_REPO',
] as const;

/**
 * Reads DEPLOY_* env vars.
 * Returns null if none are set. Throws if only partially configured.
 */
export function loadDeployConfig(): DeployConfig | null {
  const env = process.env;

  const anySet = REQUIRED_VARS.some((v) => env[v] !== undefined);
  if (!anySet) return null;

  const missing = REQUIRED_VARS.filter((v) => !env[v]);
  if (missing.length > 0) {
    throw new Error(`Self-deploy partially configured. Missing env vars: ${missing.join(', ')}`);
  }

  return {
    subscriptionId: env['DEPLOY_SUBSCRIPTION_ID']!,
    resourceGroup: env['DEPLOY_RESOURCE_GROUP']!,
    acrName: env['DEPLOY_ACR_NAME']!,
    containerAppName: env['DEPLOY_CONTAINER_APP_NAME']!,
    sourceRepo: env['DEPLOY_SOURCE_REPO']!,
    sourceBranch: env['DEPLOY_SOURCE_BRANCH'] ?? 'main',
    ...(env['DEPLOY_GITHUB_PAT'] ? { githubPat: env['DEPLOY_GITHUB_PAT'] } : {}),
    ...(env['DEPLOY_HEALTH_URL'] ? { healthUrl: env['DEPLOY_HEALTH_URL'] } : {}),
  };
}
