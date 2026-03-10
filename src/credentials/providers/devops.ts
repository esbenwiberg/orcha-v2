export interface DevOpsProfile {
  org: string;
  project: string;
  scopes: string[];
  durationHours: number;
  pat?: string;
}

export interface DevOpsProvisionResult {
  patId: string;
  env: { AZURE_DEVOPS_EXT_PAT: string };
}

let bootstrapPatResolver: (() => string | undefined) | undefined;

export function setBootstrapPatResolver(fn: () => string | undefined): void {
  bootstrapPatResolver = fn;
}

function getBootstrapToken(): string {
  const fromResolver = bootstrapPatResolver?.();
  if (fromResolver) return fromResolver;
  if (process.env['DEVOPS_BOOTSTRAP_PAT']) return process.env['DEVOPS_BOOTSTRAP_PAT'];
  if (process.env['AZURE_DEVOPS_EXT_PAT']) return process.env['AZURE_DEVOPS_EXT_PAT'];
  throw new Error(
    'No DevOps bootstrap PAT found. Set it on the Settings page or via DEVOPS_BOOTSTRAP_PAT env var.',
  );
}

// Normalize org URL to the VSSPS format (https://vssps.dev.azure.com/{org})
function getVsspsUrl(org: string): string {
  // org may be a full URL like https://dev.azure.com/myorg or just "myorg"
  const match = /dev\.azure\.com\/([^/]+)/.exec(org);
  const orgName = match ? match[1] : org;
  return `https://vssps.dev.azure.com/${orgName}`;
}

function getOrgName(org: string): string {
  const match = /dev\.azure\.com\/([^/]+)/.exec(org);
  return match ? (match[1] ?? org) : org;
}

function getDevOpsBaseUrl(org: string): string {
  const orgName = getOrgName(org);
  return `https://dev.azure.com/${orgName}`;
}

export class DevOpsProvider {
  async preflight(profile: DevOpsProfile): Promise<{ ok: boolean; reason?: string }> {
    // Direct PAT mode — validate the PAT against the org
    if (profile.pat) {
      return this.#validateDirectPat(profile.pat, profile.org);
    }

    // Bootstrap mode — validate the bootstrap PAT
    try {
      const token = getBootstrapToken();
      const base64 = Buffer.from(`:${token}`).toString('base64');

      const resp = await fetch(
        'https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1',
        {
          headers: {
            Authorization: `Basic ${base64}`,
            'User-Agent': 'orcha/1.0',
          },
        },
      );

      if (!resp.ok) {
        return { ok: false, reason: `VSSPS profile check returned ${resp.status}` };
      }

      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, reason: (err as Error).message };
    }
  }

  async provision(profile: DevOpsProfile): Promise<DevOpsProvisionResult> {
    // Direct PAT mode — validate and inject the PAT directly (no bootstrap minting)
    if (profile.pat) {
      return this.#provisionDirect(profile);
    }

    // Bootstrap mode — mint a short-lived session PAT
    return this.#provisionBootstrap(profile);
  }

  async revoke(patId: string): Promise<void> {
    // Direct PATs use 'direct:' prefix — no revocation needed (user-managed)
    if (patId.startsWith('direct:')) return;

    // Bootstrap-minted PATs — revoke via VSSPS API
    try {
      const token = getBootstrapToken();
      const base64 = Buffer.from(`:${token}`).toString('base64');

      const resp = await fetch(
        `https://vssps.dev.azure.com/_apis/tokens/pats?authorizationId=${patId}&api-version=7.1-preview.1`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Basic ${base64}`,
            'User-Agent': 'orcha/1.0',
          },
        },
      );

      if (!resp.ok && resp.status !== 404) {
        throw new Error(`Failed to revoke DevOps PAT ${patId}: ${resp.status}`);
      }
    } catch (err) {
      // Bootstrap PAT may be broken — log but don't throw (session cleanup shouldn't fail)
      console.warn(`[devops] revoke failed for ${patId}:`, err);
    }
  }

  /** Direct PAT mode: validate the PAT and inject it as AZURE_DEVOPS_EXT_PAT. */
  async #provisionDirect(profile: DevOpsProfile): Promise<DevOpsProvisionResult> {
    const pat = profile.pat!;
    const baseUrl = getDevOpsBaseUrl(profile.org);

    // Validate the PAT works against the org
    const base64 = Buffer.from(`:${pat}`).toString('base64');
    const resp = await fetch(
      `${baseUrl}/_apis/projects?api-version=7.0&$top=1`,
      {
        headers: {
          Authorization: `Basic ${base64}`,
          'User-Agent': 'orcha/1.0',
        },
      },
    );

    if (!resp.ok) {
      throw new Error(
        `DevOps PAT validation failed (${resp.status}). Check that the PAT is valid and has access to ${getOrgName(profile.org)}.`,
      );
    }

    console.log(`[devops] direct PAT validated for org=${getOrgName(profile.org)} tokenPrefix=${pat.slice(0, 8)}`);

    return {
      patId: `direct:${pat.slice(0, 8)}`,
      env: { AZURE_DEVOPS_EXT_PAT: pat },
    };
  }

  /** Bootstrap mode: mint a short-lived session PAT via the VSSPS API. */
  async #provisionBootstrap(profile: DevOpsProfile): Promise<DevOpsProvisionResult> {
    const token = getBootstrapToken();
    const base64 = Buffer.from(`:${token}`).toString('base64');
    const orgName = getOrgName(profile.org);
    const vsspsUrl = getVsspsUrl(profile.org);

    const expiryDate = new Date();
    expiryDate.setHours(expiryDate.getHours() + profile.durationHours);

    const url = `${vsspsUrl}/_apis/tokens/pats?api-version=7.1-preview.1`;
    console.log(`[devops] provision (bootstrap): url=${url} org=${orgName} tokenPrefix=${token.slice(0, 8)} scopes=${profile.scopes.join(' ')}`);

    const resp = await fetch(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${base64}`,
          'Content-Type': 'application/json',
          'User-Agent': 'orcha/1.0',
        },
        body: JSON.stringify({
          displayName: `devguard-session-${Date.now()}`,
          scope: profile.scopes.join(' '),
          validTo: expiryDate.toISOString(),
          allOrgs: false,
          targetAccounts: [orgName],
        }),
      },
    );

    if (!resp.ok) {
      const body = await resp.text();
      console.error(`[devops] provision (bootstrap) failed: status=${resp.status} body=${body.slice(0, 300)}`);
      throw new Error(
        `Failed to create DevOps PAT: ${resp.status} ${body}`,
      );
    }

    const result = (await resp.json()) as { patToken: { token: string; authorizationId: string } };
    const pat = result.patToken;

    return {
      patId: pat.authorizationId,
      env: { AZURE_DEVOPS_EXT_PAT: pat.token },
    };
  }

  /** Validate a direct PAT against the org. */
  async #validateDirectPat(pat: string, org: string): Promise<{ ok: boolean; reason?: string }> {
    try {
      const baseUrl = getDevOpsBaseUrl(org);
      const base64 = Buffer.from(`:${pat}`).toString('base64');

      const resp = await fetch(
        `${baseUrl}/_apis/projects?api-version=7.0&$top=1`,
        {
          headers: {
            Authorization: `Basic ${base64}`,
            'User-Agent': 'orcha/1.0',
          },
        },
      );

      if (!resp.ok) {
        return { ok: false, reason: `DevOps PAT validation returned ${resp.status}` };
      }

      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, reason: (err as Error).message };
    }
  }
}
