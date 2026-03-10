import type { PrIdentifier } from './types.js';

/**
 * Parse a PR URL into its components.
 *
 * Supported formats:
 *   GitHub:     https://github.com/{owner}/{repo}/pull/{number}
 *   Azure DevOps: https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{number}
 *   Azure DevOps (old): https://{org}.visualstudio.com/{project}/_git/{repo}/pullrequest/{number}
 */
export function parsePrUrl(url: string): PrIdentifier {
  const trimmed = url.trim();

  // GitHub: https://github.com/{owner}/{repo}/pull/{number}
  const ghMatch = trimmed.match(
    /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i,
  );
  if (ghMatch) {
    return {
      provider: 'github',
      owner: ghMatch[1]!,
      repo: ghMatch[2]!,
      prNumber: parseInt(ghMatch[3]!, 10),
    };
  }

  // Azure DevOps: https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{number}
  const adoMatch = trimmed.match(
    /dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)/i,
  );
  if (adoMatch) {
    return {
      provider: 'azure-devops',
      owner: decodeURIComponent(adoMatch[1]!),
      repo: decodeURIComponent(adoMatch[3]!),
      prNumber: parseInt(adoMatch[4]!, 10),
      project: decodeURIComponent(adoMatch[2]!),
    };
  }

  // Azure DevOps (old format): https://{org}.visualstudio.com/{project}/_git/{repo}/pullrequest/{number}
  const adoOldMatch = trimmed.match(
    /([^/]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)/i,
  );
  if (adoOldMatch) {
    return {
      provider: 'azure-devops',
      owner: decodeURIComponent(adoOldMatch[1]!),
      repo: decodeURIComponent(adoOldMatch[3]!),
      prNumber: parseInt(adoOldMatch[4]!, 10),
      project: decodeURIComponent(adoOldMatch[2]!),
    };
  }

  throw new Error(`Unsupported PR URL format: ${trimmed}`);
}
