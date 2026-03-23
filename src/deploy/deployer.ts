import { DefaultAzureCredential } from '@azure/identity';
import type { DeployConfig } from './deploy-config.js';

export type DeployPhase =
  | 'idle'
  | 'build-orcha'
  | 'build-caddy'
  | 'update-app'
  | 'poll-revision'
  | 'health-check'
  | 'done'
  | 'error';

export interface DeployLogEntry {
  ts: number;
  phase: DeployPhase;
  level: 'info' | 'success' | 'error';
  message: string;
}

export interface DeployState {
  phase: DeployPhase;
  busy: boolean;
  logs: DeployLogEntry[];
  tag?: string;
}

type Subscriber = (entry: DeployLogEntry) => void;

const ARM_BASE = 'https://management.azure.com';
const ACR_API = '2019-06-01-preview'; // ACR Tasks runs API
const ACA_API = '2024-03-01'; // Container Apps API

export class Deployer {
  #config: DeployConfig;
  #phase: DeployPhase = 'idle';
  #logs: DeployLogEntry[] = [];
  #subscribers = new Set<Subscriber>();
  #busy = false;
  #tag?: string;

  constructor(config: DeployConfig) {
    this.#config = config;
  }

  get busy(): boolean {
    return this.#busy;
  }

  getState(): DeployState {
    return {
      phase: this.#phase,
      busy: this.#busy,
      logs: [...this.#logs],
      ...(this.#tag ? { tag: this.#tag } : {}),
    };
  }

  subscribe(cb: Subscriber): () => void {
    this.#subscribers.add(cb);
    return () => {
      this.#subscribers.delete(cb);
    };
  }

  async deploy(tag: string): Promise<void> {
    if (this.#busy) throw new Error('Deploy already in progress');

    this.#busy = true;
    this.#logs = [];
    this.#tag = tag;
    this.#phase = 'idle';

    try {
      const credential = new DefaultAzureCredential();
      const tokenResp = await credential.getToken('https://management.azure.com/.default');
      const bearer = tokenResp.token;

      const { acrName, sourceRepo, sourceBranch, githubPat, containerAppName, resourceGroup, subscriptionId, healthUrl } = this.#config;
      const acrServer = `${acrName}.azurecr.io`;

      // Step 1: Build orcha image
      this.#emit('build-orcha', 'info', `Building orcha:${tag} via ACR Tasks...`);
      await this.#acrBuild(bearer, {
        imageName: `orcha:${tag}`,
        sourceLocation: sourceRepo,
        sourceBranch,
        dockerFilePath: 'Dockerfile',
        contextPath: '',
        ...(githubPat ? { githubPat } : {}),
      });
      this.#emit('build-orcha', 'success', `orcha:${tag} built and pushed`);

      // Step 2: Build orcha-caddy image
      this.#emit('build-caddy', 'info', `Building orcha-caddy:${tag} via ACR Tasks...`);
      await this.#acrBuild(bearer, {
        imageName: `orcha-caddy:${tag}`,
        sourceLocation: sourceRepo,
        sourceBranch,
        dockerFilePath: 'caddy/Dockerfile',
        contextPath: 'caddy',
        ...(githubPat ? { githubPat } : {}),
      });
      this.#emit('build-caddy', 'success', `orcha-caddy:${tag} built and pushed`);

      // Step 3: Update Container App
      this.#emit('update-app', 'info', `Updating Container App '${containerAppName}'...`);
      await this.#updateContainerApp(bearer, acrServer, tag);
      this.#emit('update-app', 'success', 'Container App update triggered');

      // Step 4: Poll revision
      this.#emit('poll-revision', 'info', 'Waiting for new revision to become active...');
      await this.#pollRevision(bearer);
      this.#emit('poll-revision', 'success', 'Revision provisioned');

      // Step 5: Health check (optional)
      if (healthUrl) {
        this.#emit('health-check', 'info', `Running health check: ${healthUrl}`);
        await this.#healthCheck(healthUrl);
        this.#emit('health-check', 'success', 'Health check passed');
      }

      this.#emit('done', 'success', 'Deployment complete');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.#emit('error', 'error', `Deploy failed: ${msg}`);
    } finally {
      this.#busy = false;
    }
  }

  // ── ACR Tasks build ────────────────────────────────────────────────────────

  async #acrBuild(
    bearer: string,
    opts: {
      imageName: string;
      sourceLocation: string;
      sourceBranch: string;
      dockerFilePath: string;
      contextPath: string;
      githubPat?: string;
    },
  ): Promise<void> {
    const { subscriptionId, resourceGroup, acrName } = this.#config;

    // Build the source location URL with branch and context subfolder
    let sourceLocation = opts.sourceLocation;
    const parts: string[] = [];
    if (opts.sourceBranch) parts.push(opts.sourceBranch);
    if (opts.contextPath) parts.push(opts.contextPath);
    if (parts.length > 0) sourceLocation += '#' + parts.join(':');

    const body: Record<string, unknown> = {
      type: 'DockerBuildRequest',
      dockerFilePath: opts.dockerFilePath,
      imageNames: [opts.imageName],
      isPushEnabled: true,
      sourceLocation,
      platform: { os: 'Linux', architecture: 'amd64' },
    };

    if (opts.githubPat) {
      body['credentials'] = {
        sourceRegistry: null,
        customRegistries: null,
      };
      // Use sourceToken for GitHub auth
      (body as Record<string, unknown>)['sourceToken'] = opts.githubPat;
    }

    // If there's a context subfolder, adjust docker file path for the context
    if (opts.contextPath) {
      body['dockerFilePath'] = 'Dockerfile';
    }

    const url =
      `${ARM_BASE}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` +
      `/providers/Microsoft.ContainerRegistry/registries/${acrName}/scheduleRun?api-version=${ACR_API}`;

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`ACR scheduleRun failed (${resp.status}): ${text}`);
    }

    const run = (await resp.json()) as { properties?: { runId?: string } };
    const runId = run.properties?.runId;
    if (!runId) throw new Error('ACR scheduleRun returned no runId');

    this.#emit(this.#phase, 'info', `ACR run ${runId} started, polling...`);

    // Poll run status
    await this.#pollAcrRun(bearer, runId);
  }

  async #pollAcrRun(bearer: string, runId: string): Promise<void> {
    const { subscriptionId, resourceGroup, acrName } = this.#config;
    const url =
      `${ARM_BASE}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` +
      `/providers/Microsoft.ContainerRegistry/registries/${acrName}/runs/${runId}?api-version=${ACR_API}`;

    for (let i = 0; i < 60; i++) {
      await sleep(10_000);

      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${bearer}` },
      });

      if (!resp.ok) {
        this.#emit(this.#phase, 'info', `Poll failed (${resp.status}), retrying...`);
        continue;
      }

      const data = (await resp.json()) as { properties?: { status?: string } };
      const status = data.properties?.status ?? 'unknown';

      if (status === 'Succeeded') return;
      if (status === 'Failed' || status === 'Error' || status === 'Canceled') {
        throw new Error(`ACR run ${runId} ended with status: ${status}`);
      }

      this.#emit(this.#phase, 'info', `ACR run ${runId}: ${status} (${i + 1}/60)`);
    }

    throw new Error(`ACR run ${runId} timed out after 10 minutes`);
  }

  // ── Container App update ───────────────────────────────────────────────────

  async #updateContainerApp(bearer: string, acrServer: string, tag: string): Promise<void> {
    const { subscriptionId, resourceGroup, containerAppName } = this.#config;
    const appUrl =
      `${ARM_BASE}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` +
      `/providers/Microsoft.App/containerApps/${containerAppName}?api-version=${ACA_API}`;

    // GET current app
    const getResp = await fetch(appUrl, {
      headers: { Authorization: `Bearer ${bearer}` },
    });
    if (!getResp.ok) {
      throw new Error(`GET Container App failed (${getResp.status}): ${await getResp.text()}`);
    }

    const app = (await getResp.json()) as {
      properties?: {
        template?: {
          containers?: Array<{ name?: string; image?: string }>;
        };
      };
    };

    // Find containers and update images
    const template = app.properties?.template;
    const containers = template?.containers;
    if (!containers) throw new Error('Container App has no containers');

    const orchaContainer = containers.find((c) => c.name === 'orcha');
    if (!orchaContainer) throw new Error("No container named 'orcha' found");
    orchaContainer.image = `${acrServer}/orcha:${tag}`;

    const caddyContainer = containers.find((c) => c.name === 'caddy');
    if (caddyContainer) {
      caddyContainer.image = `${acrServer}/orcha-caddy:${tag}`;
    }

    // Force a new revision even if images haven't changed (e.g. re-deploy same commit).
    // Without revisionSuffix, ACA may detect no template diff and skip revision creation,
    // causing the poll loop to time out.
    const suffix = tag.substring(0, 8) + '-' + Date.now().toString().slice(-6);

    // PATCH the app
    const patchResp = await fetch(appUrl, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        properties: { template: { containers, revisionSuffix: suffix } },
      }),
    });

    if (!patchResp.ok) {
      throw new Error(`PATCH Container App failed (${patchResp.status}): ${await patchResp.text()}`);
    }
  }

  // ── Poll revision ──────────────────────────────────────────────────────────

  async #pollRevision(bearer: string): Promise<void> {
    const { subscriptionId, resourceGroup, containerAppName } = this.#config;
    const url =
      `${ARM_BASE}/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}` +
      `/providers/Microsoft.App/containerApps/${containerAppName}/revisions?api-version=${ACA_API}`;

    for (let i = 0; i < 20; i++) {
      await sleep(15_000);

      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${bearer}` },
      });

      if (!resp.ok) {
        this.#emit('poll-revision', 'info', `Poll failed (${resp.status}), retrying...`);
        continue;
      }

      const data = (await resp.json()) as {
        value?: Array<{ properties?: { provisioningState?: string } }>;
      };

      const latest = data.value?.[0];
      const state = latest?.properties?.provisioningState ?? 'unknown';

      if (state === 'Provisioned') return;
      if (state === 'Failed') throw new Error('Revision provisioning failed');

      this.#emit('poll-revision', 'info', `Revision state: ${state} (${i + 1}/20)`);
    }

    throw new Error('Timed out waiting for revision to provision');
  }

  // ── Health check ───────────────────────────────────────────────────────────

  async #healthCheck(url: string): Promise<void> {
    for (let i = 0; i < 6; i++) {
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (resp.ok) {
          const data = (await resp.json()) as { status?: string };
          if (data.status === 'ok') return;
        }
      } catch {
        // retry
      }

      this.#emit('health-check', 'info', `Health check attempt ${i + 1}/6 failed, retrying in 5s...`);
      await sleep(5_000);
    }

    throw new Error('Health check failed after 6 attempts');
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  #emit(phase: DeployPhase, level: DeployLogEntry['level'], message: string): void {
    this.#phase = phase;
    const entry: DeployLogEntry = { ts: Date.now(), phase, level, message };
    this.#logs.push(entry);
    for (const cb of this.#subscribers) {
      try {
        cb(entry);
      } catch {
        // subscriber error
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
