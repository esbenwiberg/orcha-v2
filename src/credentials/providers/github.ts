import { execSync } from 'node:child_process';

export interface GitHubProfile {
  repos: string[];
  permissions: string[];
  durationHours: number;
}

export interface GitHubProvisionResult {
  patId: string;
  env: { GH_TOKEN: string };
}

let bootstrapPatResolver: (() => string | undefined) | undefined;

export function setBootstrapPatResolver(fn: () => string | undefined): void {
  bootstrapPatResolver = fn;
}

function getBootstrapToken(): string {
  const fromResolver = bootstrapPatResolver?.();
  if (fromResolver) return fromResolver;
  if (process.env['GITHUB_BOOTSTRAP_TOKEN']) return process.env['GITHUB_BOOTSTRAP_TOKEN'];
  if (process.env['GH_TOKEN']) return process.env['GH_TOKEN'];
  if (process.env['GITHUB_TOKEN']) return process.env['GITHUB_TOKEN'];
  try {
    return execSync('gh auth token', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    throw new Error(
      'No GitHub bootstrap token found. Set it on the Settings page or via GITHUB_BOOTSTRAP_TOKEN env var.',
    );
  }
}

export class GitHubProvider {
  async preflight(profile: GitHubProfile): Promise<{ ok: boolean; reason?: string }> {
    try {
      const token = getBootstrapToken();
      const resp = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `token ${token}`,
          'User-Agent': 'devguard/1.0',
        },
      });

      if (!resp.ok) {
        return { ok: false, reason: `GitHub API returned ${resp.status}` };
      }

      // Check for manage:personal_access_tokens scope
      const scopes = resp.headers.get('X-OAuth-Scopes') ?? '';
      if (!scopes.includes('manage:personal_access_tokens')) {
        return {
          ok: false,
          reason:
            'Bootstrap token missing manage:personal_access_tokens scope. Fine-grained PAT provisioning requires a classic PAT with this scope.',
        };
      }

      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, reason: (err as Error).message };
    }
  }

  async provision(profile: GitHubProfile): Promise<GitHubProvisionResult> {
    const token = getBootstrapToken();

    const expiryDate = new Date();
    expiryDate.setHours(expiryDate.getHours() + profile.durationHours);

    // Build repository access list
    const repositories = profile.repos.map((r) => {
      const [owner, repo] = r.split('/');
      return { owner, repo };
    });

    // Build permissions object from array of "resource:permission" strings
    const permissions: Record<string, string> = {};
    for (const perm of profile.permissions) {
      const [resource, access] = perm.split(':');
      if (resource && access) {
        permissions[resource] = access;
      }
    }

    const body: Record<string, unknown> = {
      name: `devguard-session-${Date.now()}`,
      description: 'devguard JIT credential',
      expiration_date: expiryDate.toISOString().split('T')[0], // YYYY-MM-DD
      permissions,
    };

    if (repositories.length > 0) {
      body['repositories'] = profile.repos;
    }

    const resp = await fetch('https://api.github.com/user/personal-access-tokens', {
      method: 'POST',
      headers: {
        Authorization: `token ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'devguard/1.0',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      throw new Error(`Failed to create fine-grained PAT: ${resp.status} ${await resp.text()}`);
    }

    const result = (await resp.json()) as { id: number; token: string };

    return {
      patId: String(result.id),
      env: { GH_TOKEN: result.token },
    };
  }

  async revoke(patId: string): Promise<void> {
    const token = getBootstrapToken();

    const resp = await fetch(`https://api.github.com/user/personal-access-tokens/${patId}`, {
      method: 'DELETE',
      headers: {
        Authorization: `token ${token}`,
        'User-Agent': 'devguard/1.0',
      },
    });

    if (!resp.ok && resp.status !== 404) {
      throw new Error(`Failed to revoke PAT ${patId}: ${resp.status}`);
    }
  }
}
