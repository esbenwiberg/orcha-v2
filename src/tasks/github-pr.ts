const ORCHA_MARKER = '<!-- orcha-bot -->';
const GH_API = 'https://api.github.com';

export interface PrInfo {
  owner: string;
  repo: string;
  number: number;
}

export interface PrStatus {
  state: 'open' | 'closed';
  merged: boolean;
  title: string;
}

export interface PrComment {
  id: number;
  body: string;
  createdAt: string;
  /** File path for inline review comments (null for issue-level comments). */
  path: string | null;
  /** Diff hunk context for inline review comments. */
  diffHunk: string | null;
}

/** Parse a GitHub PR URL into owner/repo/number. */
export function parsePrUrl(prUrl: string): PrInfo | null {
  const m = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]!, number: parseInt(m[3]!, 10) };
}

/** Fetch PR metadata (state, merged, title). */
export async function fetchPrStatus(pr: PrInfo, token: string): Promise<PrStatus> {
  const res = await fetch(`${GH_API}/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`, {
    headers: ghHeaders(token),
  });
  if (!res.ok) throw new Error(`GitHub API error ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as Record<string, unknown>;
  return {
    state: data['state'] as 'open' | 'closed',
    merged: data['merged'] as boolean,
    title: data['title'] as string,
  };
}

/**
 * Fetch new comments on a PR since a given watermark timestamp.
 * Combines issue-level comments and inline review comments.
 * Filters out Orcha's own comments (identified by marker).
 */
export async function fetchNewComments(
  pr: PrInfo,
  token: string,
  since: string | null,
): Promise<PrComment[]> {
  const headers = ghHeaders(token);
  const comments: PrComment[] = [];

  // Issue-level comments (supports `since` query param)
  const issueUrl = new URL(`${GH_API}/repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments`);
  if (since) issueUrl.searchParams.set('since', since);
  issueUrl.searchParams.set('per_page', '100');

  const issueRes = await fetch(issueUrl.toString(), { headers });
  if (issueRes.ok) {
    const items = (await issueRes.json()) as Array<Record<string, unknown>>;
    for (const c of items) {
      const body = c['body'] as string;
      if (body.includes(ORCHA_MARKER)) continue;
      comments.push({
        id: c['id'] as number,
        body,
        createdAt: c['created_at'] as string,
        path: null,
        diffHunk: null,
      });
    }
  }

  // Inline review comments (no `since` param — filter client-side)
  const reviewUrl = `${GH_API}/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/comments?per_page=100`;
  const reviewRes = await fetch(reviewUrl, { headers });
  if (reviewRes.ok) {
    const items = (await reviewRes.json()) as Array<Record<string, unknown>>;
    for (const c of items) {
      const createdAt = c['created_at'] as string;
      if (since && createdAt <= since) continue;
      const body = c['body'] as string;
      if (body.includes(ORCHA_MARKER)) continue;
      comments.push({
        id: c['id'] as number,
        body,
        createdAt,
        path: (c['path'] as string) ?? null,
        diffHunk: (c['diff_hunk'] as string) ?? null,
      });
    }
  }

  // Sort chronologically
  comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return comments;
}

/** Post a comment on a PR (issue-level). Includes the Orcha marker. */
export async function postPrComment(pr: PrInfo, token: string, body: string): Promise<void> {
  const markedBody = `${body}\n\n${ORCHA_MARKER}`;
  const res = await fetch(`${GH_API}/repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments`, {
    method: 'POST',
    headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: markedBody }),
  });
  if (!res.ok) {
    console.warn('[github-pr] failed to post comment: %d %s', res.status, await res.text());
  }
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}
