import type { PrInfo, PrComment } from './types.js';

function escapeForMarkdown(text: string): string {
  // Don't escape — we want the comment body to render naturally.
  // Just trim trailing whitespace per line.
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n');
}

function formatComment(comment: PrComment, index: number): string {
  const parts: string[] = [];

  // Header: file location or "General comment"
  const location = comment.filePath
    ? `\`${comment.filePath}${comment.lineNumber ? `:${comment.lineNumber}` : ''}\``
    : 'General comment';

  const statusBadge = comment.status === 'resolved' ? ' [RESOLVED]' : '';

  parts.push(`### ${index}. ${location} — @${comment.author}${statusBadge}`);
  parts.push('');
  parts.push(escapeForMarkdown(comment.body));

  // Replies
  if (comment.replies && comment.replies.length > 0) {
    parts.push('');
    for (const reply of comment.replies) {
      parts.push(`> **@${reply.author}:**`);
      // Indent reply body as blockquote
      const replyLines = escapeForMarkdown(reply.body)
        .split('\n')
        .map((line) => `> ${line}`);
      parts.push(...replyLines);
      parts.push('');
    }
  }

  return parts.join('\n');
}

/**
 * Format PR info and comments into a markdown document that Claude can read
 * and work through systematically.
 */
export function formatPrReview(pr: PrInfo): string {
  const parts: string[] = [];

  // Header
  parts.push(`# PR Review: ${pr.title}`);
  parts.push('');
  parts.push(`**Author**: @${pr.author}  `);
  parts.push(`**Branch**: \`${pr.sourceBranch}\` → \`${pr.targetBranch}\`  `);
  parts.push(`**Status**: ${pr.status}  `);
  parts.push(`**URL**: ${pr.url}`);

  // Description
  if (pr.description.trim()) {
    parts.push('');
    parts.push('## Description');
    parts.push('');
    parts.push(escapeForMarkdown(pr.description));
  }

  // Comments
  const activeComments = pr.comments.filter((c) => c.status !== 'resolved' && c.status !== 'closed');
  const resolvedComments = pr.comments.filter((c) => c.status === 'resolved' || c.status === 'closed');

  if (activeComments.length > 0) {
    parts.push('');
    parts.push('## Comments to Address');
    parts.push('');
    let idx = 1;
    for (const comment of activeComments) {
      parts.push(formatComment(comment, idx));
      parts.push('');
      idx++;
    }
  }

  if (resolvedComments.length > 0) {
    parts.push('');
    parts.push('## Resolved Comments (for context)');
    parts.push('');
    let idx = 1;
    for (const comment of resolvedComments) {
      parts.push(formatComment(comment, idx));
      parts.push('');
      idx++;
    }
  }

  if (pr.comments.length === 0) {
    parts.push('');
    parts.push('## Comments');
    parts.push('');
    parts.push('No comments on this PR yet.');
  }

  return parts.join('\n');
}
