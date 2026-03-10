import type { PrIdentifier, PrInfo, PrComment, CommentStatus } from './types.js';

interface GitHubPr {
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  head: { ref: string };
  base: { ref: string };
  user: { login: string };
}

interface GitHubReviewComment {
  id: number;
  user: { login: string };
  body: string;
  path: string;
  line: number | null;
  original_line: number | null;
  created_at: string;
  updated_at: string;
  in_reply_to_id?: number;
}

interface GitHubIssueComment {
  id: number;
  user: { login: string };
  body: string;
  created_at: string;
  updated_at: string;
}

interface GitHubReview {
  id: number;
  user: { login: string };
  body: string | null;
  state: string; // APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED
  submitted_at: string;
}

const GITHUB_API = 'https://api.github.com';

async function ghFetch<T>(path: string, token: string): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${GITHUB_API}${path}`, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API ${res.status}: ${path} — ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Paginate through all pages of a GitHub API list endpoint.
 */
async function ghFetchAll<T>(path: string, token: string): Promise<T[]> {
  const results: T[] = [];
  let url: string | null = `${GITHUB_API}${path}${path.includes('?') ? '&' : '?'}per_page=100`;

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  while (url) {
    const resp: Response = await fetch(url, { headers });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`GitHub API ${resp.status}: ${url} — ${body.slice(0, 200)}`);
    }
    const data = await resp.json() as T[];
    results.push(...data);

    // Parse Link header for next page
    const linkHeader: string | null = resp.headers.get('link');
    const nextMatch: RegExpMatchArray | null | undefined = linkHeader?.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1]! : null;
  }

  return results;
}

function mapReviewState(state: string): CommentStatus {
  switch (state) {
    case 'APPROVED':
      return 'resolved';
    case 'CHANGES_REQUESTED':
      return 'active';
    case 'DISMISSED':
      return 'closed';
    default:
      return 'active';
  }
}

/**
 * Fetch PR metadata and all comments from GitHub.
 */
export async function fetchGitHubPr(pr: PrIdentifier, token: string): Promise<PrInfo> {
  const base = `/repos/${pr.owner}/${pr.repo}/pulls/${pr.prNumber}`;

  // Fetch PR details, review comments (inline), issue comments (general), and reviews in parallel
  const [prData, reviewComments, issueComments, reviews] = await Promise.all([
    ghFetch<GitHubPr>(base, token),
    ghFetchAll<GitHubReviewComment>(`${base}/comments`, token),
    ghFetchAll<GitHubIssueComment>(`/repos/${pr.owner}/${pr.repo}/issues/${pr.prNumber}/comments`, token),
    ghFetchAll<GitHubReview>(`${base}/reviews`, token),
  ]);

  const comments: PrComment[] = [];

  // Group inline review comments into threads (reply chains)
  const rootComments = new Map<number, PrComment>();
  const replyMap = new Map<number, GitHubReviewComment[]>(); // parentId -> replies

  for (const rc of reviewComments) {
    if (rc.in_reply_to_id !== undefined) {
      const existing = replyMap.get(rc.in_reply_to_id) ?? [];
      existing.push(rc);
      replyMap.set(rc.in_reply_to_id, existing);
    } else {
      const resolvedLine = rc.line ?? rc.original_line ?? undefined;
      const comment: PrComment = {
        id: `review-${rc.id}`,
        author: rc.user.login,
        body: rc.body,
        status: 'active',
        filePath: rc.path,
        ...(resolvedLine !== undefined ? { lineNumber: resolvedLine } : {}),
        createdAt: rc.created_at,
        updatedAt: rc.updated_at,
        replies: [],
      };
      rootComments.set(rc.id, comment);
    }
  }

  // Attach replies to their root comments
  for (const [parentId, replies] of replyMap) {
    const root = rootComments.get(parentId);
    if (root) {
      root.replies = replies.map((r) => {
        const rLine = r.line ?? r.original_line ?? undefined;
        return {
          id: `review-${r.id}`,
          author: r.user.login,
          body: r.body,
          status: 'active' as CommentStatus,
          filePath: r.path,
          ...(rLine !== undefined ? { lineNumber: rLine } : {}),
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        };
      });
    }
  }
  comments.push(...rootComments.values());

  // Add general issue comments (not tied to specific lines)
  for (const ic of issueComments) {
    comments.push({
      id: `issue-${ic.id}`,
      author: ic.user.login,
      body: ic.body,
      status: 'active',
      createdAt: ic.created_at,
      updatedAt: ic.updated_at,
    });
  }

  // Add review-level comments (CHANGES_REQUESTED, APPROVED with body, etc.)
  for (const review of reviews) {
    if (!review.body?.trim()) continue; // Skip reviews with no body (just approval clicks)
    comments.push({
      id: `review-summary-${review.id}`,
      author: review.user.login,
      body: review.body,
      status: mapReviewState(review.state),
      createdAt: review.submitted_at,
    });
  }

  return {
    title: prData.title,
    description: prData.body ?? '',
    author: prData.user.login,
    url: prData.html_url,
    sourceBranch: prData.head.ref,
    targetBranch: prData.base.ref,
    status: prData.state,
    comments,
  };
}
