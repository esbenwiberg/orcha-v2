import { randomUUID } from 'node:crypto';
import { DefaultAzureCredential } from '@azure/identity';
import { AuthorizationManagementClient } from '@azure/arm-authorization';

export interface AzureProfile {
  subscriptionId: string;
  resourceGroups: string[];
  role: string;
  durationHours: number;
}

export interface PreflightResult {
  ok: boolean;
  reason?: string;
  degraded?: boolean;
}

export interface AzureProvisionResult {
  spName: string;
  appId: string;
  env: {
    AZURE_CLIENT_ID: string;
    AZURE_CLIENT_SECRET: string;
    AZURE_TENANT_ID: string;
  };
}

// Built-in role definition IDs
const BUILT_IN_ROLE_IDS: Record<string, string> = {
  Contributor: 'b24988ac-6180-42a0-ab88-20f7382dd24c',
  Reader: 'acdd72a7-3385-48ef-bd42-f606fba81ae7',
  Owner: '8e3af657-a8ff-443c-a75c-2fe8c4bcb635',
  'User Access Administrator': '18d7d88d-d35e-4fb5-a5c3-7773c20a72d6',
};

export class AzureProvider {
  async preflight(profile: AzureProfile): Promise<PreflightResult> {
    try {
      const credential = new DefaultAzureCredential();

      // 1. Can we get a token?
      await credential.getToken('https://management.azure.com/.default');

      // 2. Check role assignment access
      const authClient = new AuthorizationManagementClient(credential, profile.subscriptionId);
      try {
        const iter = authClient.roleAssignments.listForSubscription();
        await iter.next();
      } catch (err: unknown) {
        const e = err as { code?: string };
        if (e.code === 'AuthorizationFailed' || e.code === 'Forbidden') {
          return { ok: false, reason: 'role-assignment-blocked', degraded: true };
        }
        throw err;
      }

      return { ok: true };
    } catch (err: unknown) {
      const e = err as Error;
      return { ok: false, reason: e.message, degraded: false };
    }
  }

  async provision(profile: AzureProfile): Promise<AzureProvisionResult> {
    const credential = new DefaultAzureCredential();

    // Get tokens
    const mgmtToken = await credential.getToken('https://management.azure.com/.default');
    const tenantId = this.#extractTenantId(mgmtToken.token);
    const graphToken = await credential.getToken('https://graph.microsoft.com/.default');

    const spName = `devguard-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const displayName = spName;

    // Create App registration
    const appResp = await fetch('https://graph.microsoft.com/v1.0/applications', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${graphToken.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ displayName }),
    });

    if (!appResp.ok) {
      throw new Error(`Failed to create app registration: ${appResp.status} ${await appResp.text()}`);
    }

    const app = (await appResp.json()) as { id: string; appId: string };

    // Create Service Principal
    const spResp = await fetch('https://graph.microsoft.com/v1.0/servicePrincipals', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${graphToken.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ appId: app.appId }),
    });

    if (!spResp.ok) {
      await this.#deleteApp(graphToken.token, app.id).catch(() => {});
      throw new Error(`Failed to create service principal: ${spResp.status} ${await spResp.text()}`);
    }

    const sp = (await spResp.json()) as { id: string };

    // Add client secret with TTL
    const expiryDate = new Date();
    expiryDate.setHours(expiryDate.getHours() + profile.durationHours);

    const secretResp = await fetch(
      `https://graph.microsoft.com/v1.0/applications/${app.id}/addPassword`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${graphToken.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          passwordCredential: {
            displayName: 'devguard-session-secret',
            endDateTime: expiryDate.toISOString(),
          },
        }),
      },
    );

    if (!secretResp.ok) {
      await this.#deleteApp(graphToken.token, app.id).catch(() => {});
      throw new Error(`Failed to create client secret: ${secretResp.status} ${await secretResp.text()}`);
    }

    const secret = (await secretResp.json()) as { secretText: string };

    // Assign role on each resource group
    const authClient = new AuthorizationManagementClient(credential, profile.subscriptionId);
    const roleDefId = BUILT_IN_ROLE_IDS[profile.role] ?? profile.role;

    for (const rg of profile.resourceGroups) {
      const scope = `/subscriptions/${profile.subscriptionId}/resourceGroups/${rg}`;
      const roleDefinitionId = `/subscriptions/${profile.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${roleDefId}`;

      try {
        await authClient.roleAssignments.create(scope, randomUUID(), {
          principalId: sp.id,
          roleDefinitionId,
          principalType: 'ServicePrincipal',
        });
      } catch (err) {
        await this.#deleteApp(graphToken.token, app.id).catch(() => {});
        throw new Error(`Failed to assign role on ${rg}: ${String(err)}`);
      }
    }

    return {
      spName,
      appId: app.id,
      env: {
        AZURE_CLIENT_ID: app.appId,
        AZURE_CLIENT_SECRET: secret.secretText,
        AZURE_TENANT_ID: tenantId,
      },
    };
  }

  async revoke(appObjectId: string): Promise<void> {
    const credential = new DefaultAzureCredential();
    const graphToken = await credential.getToken('https://graph.microsoft.com/.default');
    await this.#deleteApp(graphToken.token, appObjectId);
  }

  async #deleteApp(bearerToken: string, appObjectId: string): Promise<void> {
    const resp = await fetch(`https://graph.microsoft.com/v1.0/applications/${appObjectId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    if (!resp.ok && resp.status !== 404) {
      throw new Error(`Failed to delete app ${appObjectId}: ${resp.status}`);
    }
  }

  #extractTenantId(jwtToken: string): string {
    try {
      const payload = jwtToken.split('.')[1];
      if (!payload) return '';
      const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as { tid?: string };
      return decoded.tid ?? '';
    } catch {
      return '';
    }
  }
}
