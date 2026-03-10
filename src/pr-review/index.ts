import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePrUrl } from './parse-pr-url.js';
import { fetchGitHubPr } from './github-fetcher.js';
import { fetchDevOpsPr } from './devops-fetcher.js';
import { formatPrReview } from './format-comments.js';
import type { PrInfo } from './types.js';

export { parsePrUrl } from './parse-pr-url.js';
export { formatPrReview } from './format-comments.js';
export type { PrInfo, PrIdentifier, PrComment } from './types.js';

export interface FetchPrOptions {
  /** The full PR URL (GitHub or Azure DevOps). */
  prUrl: string;
  /** GitHub token (GH_TOKEN / GITHUB_TOKEN) for GitHub PRs. */
  ghToken?: string;
  /** Azure DevOps PAT for DevOps PRs. */
  adoToken?: string;
}

/**
 * Fetch PR metadata and comments from the appropriate provider.
 */
export async function fetchPrComments(opts: FetchPrOptions): Promise<PrInfo> {
  const pr = parsePrUrl(opts.prUrl);

  if (pr.provider === 'github') {
    const token = opts.ghToken ?? '';
    return fetchGitHubPr(pr, token);
  }

  if (pr.provider === 'azure-devops') {
    const token = opts.adoToken ?? '';
    return fetchDevOpsPr(pr, token);
  }

  throw new Error(`Unsupported PR provider: ${pr.provider}`);
}

/**
 * Fetch PR comments and write them to .orcha/pr-review.md in the worktree.
 * Also appends a .gitignore entry so the folder isn't committed.
 * Returns the PR info for further use (e.g. branch detection).
 */
export async function writePrReview(
  worktreePath: string,
  opts: FetchPrOptions,
): Promise<PrInfo> {
  const prInfo = await fetchPrComments(opts);
  const markdown = formatPrReview(prInfo);

  const orchaDir = join(worktreePath, '.orcha');
  mkdirSync(orchaDir, { recursive: true });
  writeFileSync(join(orchaDir, 'pr-review.md'), markdown, 'utf8');

  // Ensure .orcha/ is gitignored
  const gitignorePath = join(worktreePath, '.gitignore');
  try {
    const { readFileSync } = await import('node:fs');
    const existing = readFileSync(gitignorePath, 'utf8');
    if (!existing.includes('.orcha/')) {
      writeFileSync(gitignorePath, existing.trimEnd() + '\n.orcha/\n', 'utf8');
    }
  } catch {
    // .gitignore doesn't exist — create one with just .orcha/
    writeFileSync(gitignorePath, '.orcha/\n', 'utf8');
  }

  return prInfo;
}
