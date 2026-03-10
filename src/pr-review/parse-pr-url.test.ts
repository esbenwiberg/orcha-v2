import { describe, it, expect } from 'vitest';
import { parsePrUrl } from './parse-pr-url.js';

describe('parsePrUrl', () => {
  it('parses a GitHub PR URL', () => {
    const result = parsePrUrl('https://github.com/acme/my-repo/pull/42');
    expect(result).toEqual({
      provider: 'github',
      owner: 'acme',
      repo: 'my-repo',
      prNumber: 42,
    });
  });

  it('parses a GitHub PR URL with trailing slash or query', () => {
    const result = parsePrUrl('https://github.com/org/repo/pull/123/files');
    expect(result).toEqual({
      provider: 'github',
      owner: 'org',
      repo: 'repo',
      prNumber: 123,
    });
  });

  it('parses an Azure DevOps PR URL', () => {
    const result = parsePrUrl('https://dev.azure.com/myorg/myproject/_git/myrepo/pullrequest/99');
    expect(result).toEqual({
      provider: 'azure-devops',
      owner: 'myorg',
      repo: 'myrepo',
      prNumber: 99,
      project: 'myproject',
    });
  });

  it('parses an old-style Azure DevOps (visualstudio.com) URL', () => {
    const result = parsePrUrl('https://myorg.visualstudio.com/myproject/_git/myrepo/pullrequest/7');
    expect(result).toEqual({
      provider: 'azure-devops',
      owner: 'myorg',
      repo: 'myrepo',
      prNumber: 7,
      project: 'myproject',
    });
  });

  it('trims whitespace', () => {
    const result = parsePrUrl('  https://github.com/a/b/pull/1  ');
    expect(result.provider).toBe('github');
    expect(result.prNumber).toBe(1);
  });

  it('throws on unsupported URL', () => {
    expect(() => parsePrUrl('https://gitlab.com/foo/bar/merge_requests/1')).toThrow('Unsupported PR URL format');
  });

  it('throws on garbage input', () => {
    expect(() => parsePrUrl('not-a-url')).toThrow('Unsupported PR URL format');
  });
});
