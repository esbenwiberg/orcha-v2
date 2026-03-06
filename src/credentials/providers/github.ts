import { execSync } from 'node:child_process';

export interface GitHubProfile {
  pat?: string;
}

export interface GitHubProvisionResult {
  patId?: string;
  env: { GH_TOKEN: string };
}

function resolveToken(profile: GitHubProfile): string {
  if (profile.pat) return profile.pat;
  if (process.env['GH_TOKEN']) return process.env['GH_TOKEN'];
  if (process.env['GITHUB_TOKEN']) return process.env['GITHUB_TOKEN'];
  try {
    return execSync('gh auth token', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    throw new Error(
      'No GitHub PAT found. Set one on the credential profile or via GH_TOKEN / GITHUB_TOKEN env var.',
    );
  }
}

export class GitHubProvider {
  async preflight(profile: GitHubProfile): Promise<{ ok: boolean; reason?: string }> {
    try {
      const token = resolveToken(profile);
      const resp = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `token ${token}`,
          'User-Agent': 'orcha/2.0',
        },
      });

      if (!resp.ok) {
        return { ok: false, reason: `GitHub API returned ${resp.status}` };
      }

      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, reason: (err as Error).message };
    }
  }

  async provision(profile: GitHubProfile): Promise<GitHubProvisionResult> {
    const token = resolveToken(profile);

    // Validate the token works
    const resp = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `token ${token}`,
        'User-Agent': 'orcha/2.0',
      },
    });

    if (!resp.ok) {
      throw new Error(`GitHub token validation failed: ${resp.status}`);
    }

    return {
      env: { GH_TOKEN: token },
    };
  }

  async revoke(_patId: string): Promise<void> {
    // No-op — we don't create tokens, so we don't revoke them.
    // The user manages their own PAT lifecycle in GitHub.
  }
}
