import { randomUUID } from 'node:crypto';
import { AzureProvider } from './providers/azure.js';
import { GitHubProvider } from './providers/github.js';
import { DevOpsProvider } from './providers/devops.js';
import type { CredentialProfile, ActiveCredentials, CreateSessionCredentialsInput } from './types.js';

export interface ProvisionResult {
  activeCreds: ActiveCredentials;
  env: Record<string, string>;
}

export class CredentialManager {
  readonly #azure = new AzureProvider();
  readonly #github = new GitHubProvider();
  readonly #devops = new DevOpsProvider();

  /**
   * Provision credentials for a profile.
   * Returns the ActiveCredentials record (without DB storage) and the env vars to inject.
   * Callers are responsible for persisting to DB.
   */
  async provision(profile: CredentialProfile): Promise<ProvisionResult> {
    const env: Record<string, string> = {};
    const rollbacks: Array<() => Promise<void>> = [];

    let azureSpName: string | undefined;
    let azureAppId: string | undefined;
    let githubPatId: string | undefined;
    let devopsPatId: string | undefined;

    try {
      // Run all providers in parallel
      const results = await Promise.allSettled([
        profile.azure
          ? this.#provisionAzure(profile)
          : Promise.resolve(null),
        profile.github
          ? this.#provisionGitHub(profile)
          : Promise.resolve(null),
        profile.devops
          ? this.#provisionDevOps(profile)
          : Promise.resolve(null),
      ]);

      const [azureResult, githubResult, devopsResult] = results;

      // Azure
      if (azureResult.status === 'fulfilled' && azureResult.value !== null) {
        const { spName, appId, env: azureEnv } = azureResult.value;
        azureSpName = spName;
        azureAppId = appId;
        Object.assign(env, azureEnv);
        rollbacks.push(() => this.#azure.revoke(appId));
      } else if (azureResult.status === 'rejected') {
        throw azureResult.reason as Error;
      }

      // GitHub
      if (githubResult.status === 'fulfilled' && githubResult.value !== null) {
        const { patId, env: ghEnv } = githubResult.value;
        if (patId) githubPatId = patId;
        Object.assign(env, ghEnv);
        // No rollback needed — we don't create tokens
      } else if (githubResult.status === 'rejected') {
        throw githubResult.reason as Error;
      }

      // DevOps
      if (devopsResult.status === 'fulfilled' && devopsResult.value !== null) {
        const { patId, env: devopsEnv } = devopsResult.value;
        devopsPatId = patId;
        Object.assign(env, devopsEnv);
        rollbacks.push(() => this.#devops.revoke(patId));
      } else if (devopsResult.status === 'rejected') {
        throw devopsResult.reason as Error;
      }
    } catch (err) {
      // Rollback already-provisioned credentials
      await Promise.allSettled(rollbacks.map((fn) => fn()));
      throw err;
    }

    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + profile.durationHours);

    const activeCreds: ActiveCredentials = {
      id: randomUUID(),
      profileId: profile.id,
      profileName: profile.name,
      expiresAt,
      createdAt: new Date(),
      ...(azureSpName !== undefined ? { azureSpName } : {}),
      ...(azureAppId !== undefined ? { azureAppId } : {}),
      ...(githubPatId !== undefined ? { githubPatId } : {}),
      ...(devopsPatId !== undefined ? { devopsPatId } : {}),
    };

    return { activeCreds, env };
  }

  async revoke(activeCreds: ActiveCredentials): Promise<void> {
    const tasks: Array<Promise<void>> = [];

    if (activeCreds.azureAppId) {
      tasks.push(this.#azure.revoke(activeCreds.azureAppId));
    }
    if (activeCreds.githubPatId) {
      tasks.push(this.#github.revoke(activeCreds.githubPatId));
    }
    if (activeCreds.devopsPatId) {
      tasks.push(this.#devops.revoke(activeCreds.devopsPatId));
    }

    await Promise.allSettled(tasks);
  }

  async #provisionAzure(profile: CredentialProfile) {
    if (!profile.azure) return null;
    const preflight = await this.#azure.preflight({ ...profile.azure, durationHours: profile.durationHours });
    if (!preflight.ok && preflight.degraded) {
      console.warn(
        `⚠ Azure SP provisioning unavailable: ${preflight.reason}. GitHub and DevOps credentials will still be provisioned.`,
      );
      return null;
    }
    if (!preflight.ok) {
      throw new Error(`Azure preflight failed: ${preflight.reason}`);
    }
    return this.#azure.provision({ ...profile.azure, durationHours: profile.durationHours });
  }

  async #provisionGitHub(profile: CredentialProfile) {
    if (!profile.github) return null;
    return this.#github.provision(profile.github);
  }

  async #provisionDevOps(profile: CredentialProfile) {
    if (!profile.devops) return null;
    return this.#devops.provision({ ...profile.devops, durationHours: profile.durationHours });
  }
}

export const credentialManager = new CredentialManager();
