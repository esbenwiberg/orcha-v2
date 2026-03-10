import { describe, it, expect } from 'vitest';
import { formatPrReview } from './format-comments.js';
import type { PrInfo } from './types.js';

describe('formatPrReview', () => {
  it('formats PR with inline and general comments', () => {
    const pr: PrInfo = {
      title: 'Fix auth timeout',
      description: 'Fixes the timeout issue in auth handler.',
      author: 'john',
      url: 'https://github.com/acme/app/pull/42',
      sourceBranch: 'fix/auth-timeout',
      targetBranch: 'main',
      status: 'open',
      comments: [
        {
          id: '1',
          author: 'reviewer',
          body: 'Use exponential backoff here.',
          status: 'active',
          filePath: 'src/auth/handler.ts',
          lineNumber: 45,
          createdAt: '2024-01-01T00:00:00Z',
        },
        {
          id: '2',
          author: 'reviewer',
          body: 'Looks good overall.',
          status: 'active',
          createdAt: '2024-01-01T00:00:00Z',
        },
        {
          id: '3',
          author: 'reviewer',
          body: 'Already addressed.',
          status: 'resolved',
          filePath: 'src/auth/handler.ts',
          lineNumber: 10,
          createdAt: '2024-01-01T00:00:00Z',
        },
      ],
    };

    const result = formatPrReview(pr);

    expect(result).toContain('# PR Review: Fix auth timeout');
    expect(result).toContain('**Author**: @john');
    expect(result).toContain('`fix/auth-timeout` → `main`');
    expect(result).toContain('## Comments to Address');
    expect(result).toContain('`src/auth/handler.ts:45`');
    expect(result).toContain('Use exponential backoff here.');
    expect(result).toContain('General comment');
    expect(result).toContain('## Resolved Comments (for context)');
    expect(result).toContain('Already addressed.');
  });

  it('handles PR with no comments', () => {
    const pr: PrInfo = {
      title: 'Empty PR',
      description: '',
      author: 'bot',
      url: 'https://github.com/a/b/pull/1',
      sourceBranch: 'feat',
      targetBranch: 'main',
      status: 'open',
      comments: [],
    };

    const result = formatPrReview(pr);
    expect(result).toContain('No comments on this PR yet.');
  });

  it('includes reply threads', () => {
    const pr: PrInfo = {
      title: 'With replies',
      description: '',
      author: 'a',
      url: 'https://github.com/a/b/pull/1',
      sourceBranch: 'feat',
      targetBranch: 'main',
      status: 'open',
      comments: [
        {
          id: '1',
          author: 'reviewer',
          body: 'Please fix this.',
          status: 'active',
          filePath: 'index.ts',
          lineNumber: 5,
          createdAt: '2024-01-01T00:00:00Z',
          replies: [
            {
              id: '2',
              author: 'author',
              body: 'Done, updated.',
              status: 'active',
              createdAt: '2024-01-02T00:00:00Z',
            },
          ],
        },
      ],
    };

    const result = formatPrReview(pr);
    expect(result).toContain('**@author:**');
    expect(result).toContain('Done, updated.');
  });
});
