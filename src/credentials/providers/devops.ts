export interface DevOpsProfile {
  org: string;
  project: string;
  scopes: string[];
  durationHours: number;
}

export interface DevOpsProvisionResult {
  patId: string;
  env: { AZURE_DEVOPS_EXT_PAT: string };
}

function getBootstrapToken(): string {
  if (process.env['DEVOPS_BOOTSTRAP_PAT']) return process.env['DEVOPS_BOOTSTRAP_PAT'];
  if (process.env['AZURE_DEVOPS_EXT_PAT']) return process.env['AZURE_DEVOPS_EXT_PAT'];
  throw new Error(
    'No DevOps bootstrap PAT found. Set DEVOPS_BOOTSTRAP_PAT or AZURE_DEVOPS_EXT_PAT.',
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

export class DevOpsProvider {
  async preflight(): Promise<{ ok: boolean; reason?: string }> {
    try {
      const token = getBootstrapToken();
      const base64 = Buffer.from(`:${token}`).toString('base64');

      const resp = await fetch(
        'https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1',
        {
          headers: {
            Authorization: `Basic ${base64}`,
            'User-Agent': 'devguard/1.0',
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
    const token = getBootstrapToken();
    const base64 = Buffer.from(`:${token}`).toString('base64');
    const orgName = getOrgName(profile.org);
    const vsspsUrl = getVsspsUrl(profile.org);

    const expiryDate = new Date();
    expiryDate.setHours(expiryDate.getHours() + profile.durationHours);

    const resp = await fetch(
      `${vsspsUrl}/_apis/tokens/pats?api-version=7.1-preview.1`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${base64}`,
          'Content-Type': 'application/json',
          'User-Agent': 'devguard/1.0',
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
      throw new Error(
        `Failed to create DevOps PAT: ${resp.status} ${await resp.text()}`,
      );
    }

    const result = (await resp.json()) as { patToken: { token: string; authorizationId: string } };
    const pat = result.patToken;

    return {
      patId: pat.authorizationId,
      env: { AZURE_DEVOPS_EXT_PAT: pat.token },
    };
  }

  async revoke(patId: string): Promise<void> {
    const token = getBootstrapToken();
    const base64 = Buffer.from(`:${token}`).toString('base64');

    // Get org from stored data — we use the VSSPS global endpoint for revocation
    const resp = await fetch(
      `https://vssps.dev.azure.com/_apis/tokens/pats?authorizationId=${patId}&api-version=7.1-preview.1`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Basic ${base64}`,
          'User-Agent': 'devguard/1.0',
        },
      },
    );

    if (!resp.ok && resp.status !== 404) {
      throw new Error(`Failed to revoke DevOps PAT ${patId}: ${resp.status}`);
    }
  }
}
