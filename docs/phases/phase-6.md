# Phase 6: Phase 6 – Container Deployment & Persistence
**Milestones: 7**

Make the container production-ready on Azure Container Apps with durable state. This phase resolves the storage strategy for worktrees and SQLite, wires up the CI/CD pipeline, and validates that sessions survive restarts.

## Milestone 1: Persistent volume strategy: document and implement /data mount for SQLite; worktree volume using Container Apps NFS-backed storage or ephemeral-with-bare-repo-on-blob hybrid
Define and implement the storage layout under /data, ensure SQLite opens from /data/orcha.db, document the worktree hybrid strategy (ephemeral local worktrees reconstructed from a bare repo on Azure Blob Storage), and add a startup volume check that warns when /data is not a mounted persistent volume.

1. Create `src/storage/paths.ts` that exports a single `StoragePaths` object with fields: `dataDir` (defaults to `process.env.ORCHA_DATA_DIR ?? '/data'`), `dbPath` (`${dataDir}/orcha.db`), `bareRepoDir` (`${dataDir}/bare-repos`), `worktreeBaseDir` (`${dataDir}/worktrees`), and `logsDir` (`${dataDir}/logs`). Export a `getStoragePaths()` function that returns this object, resolved once at module load.
2. Open `src/db/database.ts` (established in Phase 1) and change the hardcoded SQLite path to call `getStoragePaths().dbPath` instead of a relative or `/tmp` path. Ensure the directory is `mkdirSync`-created with `{ recursive: true }` before `better-sqlite3` opens the file.
3. Create `src/storage/volume-check.ts` exporting an async function `checkVolumeMount(dir: string): Promise<{ persistent: boolean; warning: string | null }>`. Inside, read `/proc/mounts` (or use `fs.statSync` with `dev` field comparison against the parent dir on Linux) to determine if `dir` is a distinct filesystem mount point. If not, set `warning` to a human-readable string: `'WARNING: /data is not a persistent mount — SQLite and worktrees will be lost on container restart'`. On non-Linux hosts (e.g. macOS dev), always return `{ persistent: false, warning: null }` to avoid false alarms during local development (detect via `process.platform !== 'linux'`).
4. Open `src/session/worktree-manager.ts` (established in Phase 2) and update `createWorktree()` to use `getStoragePaths().worktreeBaseDir` as the base directory for all worktree paths, replacing any previous hardcoded or temp-based path.
5. In `src/session/worktree-manager.ts`, add a `ensureBareRepo(repoUrl: string): Promise<string>` function that clones `repoUrl` as a bare repo into `getStoragePaths().bareRepoDir/<repo-slug>` if it does not already exist, then sets the local worktree's `--separate-git-dir` pointing into this bare repo. This enables the ephemeral-with-bare-repo-on-blob hybrid: the bare object store persists across restarts while working trees are reconstructed on demand.
6. Write `docs/storage-strategy.md` documenting: the `/data` directory layout, the bare-repo-on-blob hybrid rationale (git POSIX locking issues with Azure Files ruled out Azure Files; Azure Blob via blobfuse2 mount or direct API access for the bare repo avoids those locks while keeping the working tree local and fast), the ephemeral worktree reconstruction flow, and the fallback behaviour when `/data` is not mounted.
7. Add a Vitest unit test in `src/storage/volume-check.test.ts` that stubs `process.platform` to `'win32'` and asserts `checkVolumeMount('/data')` returns `{ persistent: false, warning: null }`, and a second test that stubs `process.platform` to `'linux'` and mocks `/proc/mounts` content without the target dir, asserting the warning string is set.

**Key files**: src/storage/paths.ts, src/storage/volume-check.ts, src/db/database.ts, src/session/worktree-manager.ts, docs/storage-strategy.md

**Verification**:
```bash
npm run build && npm run test -- src/storage/ src/db/ && node -e "require('./dist/storage/volume-check').checkVolumeMount('/data')"
```

## Milestone 2: Azure Container Apps bicep/terraform: container app, environment, NFS volume mount, managed identity
Emit a structured startup diagnostic block on every boot that logs auth mode, storage paths, git version, node-pty version, Node.js version, and whether /data is a persistent mount, making it easy to diagnose misconfiguration from container logs.

1. Create `src/diagnostics/startup.ts` exporting an async function `emitStartupDiagnostics(): Promise<void>`. This function gathers the following fields into a single plain object: `auth_mode` (read from `process.env.AUTH_MODE ?? 'none'`), `db_path` (from `getStoragePaths().dbPath`), `worktree_base` (from `getStoragePaths().worktreeBaseDir`), `bare_repo_dir` (from `getStoragePaths().bareRepoDir`), `node_version` (from `process.version`), `git_version` (spawn `git --version` with `execSync` and capture stdout, trim whitespace; on failure set to `'git not found'`), `node_pty_version` (read `require('../node_modules/node-pty/package.json').version` via `fs.readFileSync` + `JSON.parse`; on failure set to `'unknown'`), `data_persistent` (call `checkVolumeMount(getStoragePaths().dataDir)` and use the boolean result), and `data_warning` (the string or null from `checkVolumeMount`).
2. Inside `emitStartupDiagnostics()`, call `console.log(JSON.stringify({ event: 'startup_diagnostics', ...gatheredFields }))` to emit a single structured JSON line. If `data_warning` is non-null, additionally call `console.warn(data_warning)` so it appears prominently in container logs regardless of log parsing.
3. Open `src/web/start-server.ts` and add `await emitStartupDiagnostics()` as the very first statement inside the startup async IIFE, before the Express app is created or any route is registered, so diagnostics always appear even if subsequent startup fails.
4. Add a Vitest test in `src/diagnostics/startup.test.ts` that spies on `console.log` and `console.warn`, calls `emitStartupDiagnostics()`, then asserts: the log was called once, the parsed JSON contains keys `auth_mode`, `db_path`, `git_version`, `node_pty_version`, `node_version`, `data_persistent`, and `data_warning`.

**Key files**: src/diagnostics/startup.ts, src/web/start-server.ts

**Verification**:
```bash
npm run build && node dist/web/start-server.js 2>&1 | head -40 | grep -E '(auth_mode|db_path|git_version|node_pty|persistent)'
```

## Milestone 3: Caddy sidecar configuration: TLS termination, localhost reverse proxy to Express, automatic Let's Encrypt
Write a production-ready multi-stage Dockerfile that produces a minimal image with node-pty native bindings, git, and the blobfuse2 prerequisite packages installed, running as a non-root user with /data as a declared volume.

1. Create `Dockerfile` with two stages. Stage 1 (`builder`): use `node:22-bookworm-slim` as base, set `WORKDIR /build`, copy `package.json` and `package-lock.json`, run `npm ci --include=dev` (needed for TypeScript compilation), copy `src/` and `tsconfig.json`, run `npm run build` to emit `dist/`.
2. Stage 2 (`runtime`): use `node:22-bookworm-slim` as base, install system packages in a single `RUN apt-get update && apt-get install -y --no-install-recommends git fuse3 ca-certificates && rm -rf /var/lib/apt/lists/*` layer (fuse3 is needed by blobfuse2; ca-certificates enables TLS). Do not install blobfuse2 itself in the image — the Azure Container Apps NFS/Blob volume mount is handled by the infrastructure layer outside the container.
3. In the runtime stage, create a non-root user: `RUN groupadd -r orcha && useradd -r -g orcha -d /app orcha`. Set `WORKDIR /app`.
4. Copy from the builder stage: `COPY --from=builder /build/dist ./dist`, `COPY --from=builder /build/node_modules ./node_modules`, `COPY --from=builder /build/package.json ./package.json`.
5. Declare `VOLUME /data` and `EXPOSE 3000` in the Dockerfile. Set `ENV NODE_ENV=production ORCHA_DATA_DIR=/data`.
6. Add `USER orcha` before the final `CMD ["node", "dist/web/start-server.js"]` so the process never runs as root.
7. Create `.dockerignore` listing: `node_modules`, `dist`, `.git`, `*.test.ts`, `src/__tests__`, `docs`, `brainstorms`, `*.md`, `.env*`, `docker-compose*.yml`. This prevents build-context bloat.
8. Create `docker-compose.dev.yml` for local development with a service `orcha` using `build: .`, mounting `./data-dev:/data` as a named volume, setting `AUTH_MODE=none`, and mapping `3000:3000`. Include a comment explaining this file is for local testing only and not used in CI.

**Key files**: Dockerfile, .dockerignore, docker-compose.dev.yml

**Verification**:
```bash
docker build -t orcha:local . && docker run --rm -e AUTH_MODE=token -e ORCHA_TOKEN=test123 -p 3000:3000 orcha:local node dist/web/start-server.js 2>&1 | grep startup_diagnostics
```

## Milestone 4: GitHub Actions CI: build Docker image, run Vitest, push to Azure Container Registry on main merge
Provide a Caddy sidecar that handles TLS termination via automatic Let's Encrypt and proxies HTTPS traffic to the Express server on localhost:3000, with WebSocket upgrade support, ready to be declared as a second container in the Azure Container Apps revision.

1. Create `caddy/Caddyfile` with the following content. Use the `{$ORCHA_DOMAIN}` environment variable as the site address so the domain is injected at runtime. Configure `reverse_proxy localhost:3000` as the single directive. Add `header_up X-Forwarded-Proto https` to inform Express of the original protocol. Add `@websockets { header Connection *Upgrade* header Upgrade websocket }` matcher and `handle @websockets { reverse_proxy localhost:3000 { transport http { versions h1 } } }` block placed before the general `reverse_proxy` directive to ensure WebSocket upgrade headers are forwarded correctly.
2. Add `tls {$ACME_EMAIL}` directive inside the site block so Caddy requests a Let's Encrypt certificate for the configured domain using the email address from the environment variable. Add a fallback: if `ORCHA_DOMAIN` is `localhost`, Caddy should use `tls internal` (self-signed) to avoid ACME errors in local testing — implement this by providing a second Caddyfile snippet for local use or document the override.
3. Create `caddy/Dockerfile` using `caddy:2-alpine` as base, `COPY Caddyfile /etc/caddy/Caddyfile`, and `EXPOSE 80 443`. No additional packages are needed.
4. Create `docs/caddy-sidecar.md` explaining: how Caddy is declared as a second container in the Container Apps revision sharing the same network namespace (so `localhost:3000` is the Express server), the required environment variables (`ORCHA_DOMAIN`, `ACME_EMAIL`), how Let's Encrypt certificate storage works with a persistent volume (Caddy stores certs in `/data/caddy` by default — map this to the same `/data` persistent volume under a `caddy/` subdirectory by setting the `CADDY_DATA_DIR` env var in the Caddyfile via `storage file_system { root /data/caddy }`), and the WebSocket upgrade configuration rationale.
5. Update `src/storage/paths.ts` to export an additional field `caddyDataDir` set to `${dataDir}/caddy` so the path is consistent with the rest of the storage layout and referenced in documentation.
6. Verify the Caddyfile syntax is valid by running `docker run --rm -v $(pwd)/caddy/Caddyfile:/etc/caddy/Caddyfile caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile` and capturing the exit code.

**Key files**: caddy/Caddyfile, caddy/Dockerfile, docs/caddy-sidecar.md

**Verification**:
```bash
docker build -t orcha-caddy:local ./caddy && docker run --rm orcha-caddy:local caddy validate --config /etc/caddy/Caddyfile
```

## Milestone 5: GitHub Actions CD: deploy to Container Apps on registry push with health check gate
Author Bicep templates that provision the full Azure Container Apps environment: Container Apps Environment, the orcha Container App with persistent NFS volume mount for /data, the Caddy sidecar container, a managed identity for ACR pull access, and all necessary role assignments.

1. Create `infra/modules/storage.bicep` that provisions: an Azure Storage Account (kind `StorageV2`, SKU `Standard_LRS`, with `allowBlobPublicAccess: false` and `supportsHttpsTrafficOnly: true`), a Blob Service, a container named `bare-repos` for the git bare repositories, and a File Share named `orcha-data` (quota 5GB) for the `/data` persistent mount. Output the storage account name, the file share name, and the storage account key as secure outputs.
2. Create `infra/modules/container-env.bicep` that provisions a `Microsoft.App/managedEnvironments` resource. Attach the file share as a storage definition under `properties.appLogsConfiguration` using the storage account key from the storage module output. Define an `azureFile` storage item named `orcha-data-storage` pointing to the file share with access mode `ReadWrite`. Output the environment resource ID and the storage item name.
3. Create `infra/modules/container-app.bicep` with parameters: `environmentId`, `storageItemName`, `acrLoginServer`, `imageTag`, `orchaToken` (secure string), `orchaDomain`, `acmeEmail`, and `managedIdentityId`. Define a `Microsoft.App/containerApps` resource with: `properties.environmentId`, `properties.configuration.registries` pointing to the ACR using the managed identity (set `identity` to the managed identity resource ID and omit password), `properties.configuration.ingress` disabled (Caddy handles ingress — set `external: false` and only allow internal traffic), `properties.template.volumes` with one volume of type `AzureFile` referencing `storageItemName` named `data-vol`. Define two containers in `properties.template.containers`: container 1 `orcha` using image `${acrLoginServer}/orcha:${imageTag}` with `volumeMounts` mounting `data-vol` at `/data`, env vars `ORCHA_DATA_DIR=/data`, `AUTH_MODE=token`, `ORCHA_TOKEN` from the secure parameter, resource requests of 0.5 CPU and 1Gi memory; container 2 `caddy` using image `${acrLoginServer}/orcha-caddy:${imageTag}` with the same volume mount (for cert storage at `/data/caddy`), env vars `ORCHA_DOMAIN` and `ACME_EMAIL`, resource requests of 0.25 CPU and 256Mi memory.
4. Create `infra/main.bicep` that declares parameters `location`, `resourceGroupName`, `imageTag`, `orchaToken` (secure), `orchaDomain`, `acmeEmail`, and chains the three modules: storage → container-env → container-app. Create a `Microsoft.ManagedIdentity/userAssignedIdentities` resource for ACR pull and assign it the `AcrPull` role on the ACR using a `Microsoft.Authorization/roleAssignments` resource. Pass the managed identity principalId and resourceId into the container-app module.
5. Create `infra/parameters.example.json` with placeholder values for all parameters and a comment (using the `//` style supported by Bicep parameter files) explaining each variable. Include `imageTag: "latest"`, `orchaDomain: "orcha.example.com"`, `acmeEmail: "ops@example.com"`, and `orchaToken: "REPLACE_ME"`.
6. Write `docs/deployment-guide.md` with step-by-step instructions: prerequisites (Azure CLI, Bicep CLI, Docker), how to create the resource group, how to create the ACR, how to push images, how to run `az deployment group create`, how to retrieve the app URL, and how to rotate the `ORCHA_TOKEN` secret by updating the container app revision.

**Key files**: infra/main.bicep, infra/modules/container-app.bicep, infra/modules/container-env.bicep, infra/modules/storage.bicep, infra/parameters.example.json, docs/deployment-guide.md

**Verification**:
```bash
az bicep build --file infra/main.bicep && az deployment group what-if --resource-group rg-orcha-dev --template-file infra/main.bicep --parameters @infra/parameters.example.json
```

## Milestone 6: Startup diagnostics: log auth mode, storage paths, git version, node-pty version on boot; warn if /data is not a persistent volume
Implement the continuous integration workflow that runs Vitest on every push and pull request, builds both Docker images on main branch merges, and pushes them to Azure Container Registry tagged with the git SHA.

1. Create `.github/workflows/ci.yml` with `name: CI` and triggers `on: { push: { branches: ['*'] }, pull_request: { branches: ['main'] } }`. Define a single job `test` running on `ubuntu-latest`. Steps: (a) `actions/checkout@v4`, (b) `actions/setup-node@v4` with `node-version: '22'` and `cache: 'npm'`, (c) `npm ci`, (d) `npm run build` — fail fast if TypeScript compilation fails, (e) `npm run test -- --reporter=verbose` to run the full Vitest suite. Add `env: { CI: true }` to ensure Vitest does not open a watch mode TTY.
2. Create `.github/workflows/push-images.yml` with `name: Push Images` and trigger `on: { workflow_run: { workflows: ['CI'], types: ['completed'], branches: ['main'] } }` plus a condition `if: github.event.workflow_run.conclusion == 'success'` on the job level, ensuring images are only pushed when CI passes. This separates test gating from image publishing without duplicating the test run.
3. In `push-images.yml`, define job `build-and-push` running on `ubuntu-latest` with permissions `contents: read` and `id-token: write` (for OIDC). Steps: (a) `actions/checkout@v4` with `ref: ${{ github.event.workflow_run.head_sha }}` to check out the exact commit that triggered CI, (b) extract the short SHA into `GIT_SHA` via `echo "GIT_SHA=$(echo ${{ github.event.workflow_run.head_sha }} | cut -c1-8)" >> $GITHUB_ENV`, (c) `azure/login@v2` using federated OIDC credentials from repository secrets `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` (no client secret needed with OIDC), (d) `az acr login --name ${{ secrets.ACR_NAME }}`, (e) `docker build -t ${{ secrets.ACR_NAME }}.azurecr.io/orcha:${{ env.GIT_SHA }} -t ${{ secrets.ACR_NAME }}.azurecr.io/orcha:latest .`, (f) `docker push ${{ secrets.ACR_NAME }}.azurecr.io/orcha:${{ env.GIT_SHA }} && docker push ${{ secrets.ACR_NAME }}.azurecr.io/orcha:latest`, (g) repeat steps (e–f) for the Caddy image using `./caddy` as build context and `/orcha-caddy` as the image name, (h) output `echo "image_tag=${{ env.GIT_SHA }}" >> $GITHUB_OUTPUT` as a named output `image_tag` for the downstream CD workflow to consume.
4. Add a `DOCKER_BUILDKIT=1` environment variable to all `docker build` steps to enable BuildKit for faster layer caching.
5. In the repository, document in `docs/deployment-guide.md` under a new section "GitHub Actions Setup" the required secrets (`ACR_NAME`, `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`, `CONTAINER_APP_NAME`) and how to configure the OIDC federated credential in Entra ID for the service principal used by the actions.

**Key files**: .github/workflows/ci.yml, .github/workflows/push-images.yml

**Verification**:
```bash
act push --job test 2>&1 | tail -20  # local validation with act; or push a branch and verify GitHub Actions UI shows green
```

## Milestone 7: Smoke test suite: container start → create session → terminal connects → session persists after restart
Implement the continuous deployment workflow that triggers on a successful image push, creates a new Container Apps revision with the new image tag, waits for the revision to become active, and gates the deployment on a successful HTTP health check response.

1. Open `src/web/routes/health.ts` (create if it does not exist from Phase 3) and ensure it exports an Express `Router` that handles `GET /health`. The handler must: call `getStoragePaths()` to verify the data directory exists via `fs.existsSync`, perform a lightweight SQLite read (e.g. `db.prepare('SELECT 1').get()`) to confirm the database is reachable, collect uptime via `process.uptime()`, and respond with `200 OK` and JSON body `{ status: 'ok', uptime: <seconds>, db: 'ok', dataDir: <path>, timestamp: <ISO string> }`. On any failure, respond with `503 Service Unavailable` and `{ status: 'error', reason: <message> }`. Register this router in `src/web/server.ts` at path `/health` before auth middleware so the health check does not require authentication.
2. Create `.github/workflows/cd.yml` with `name: CD` and trigger `on: { workflow_run: { workflows: ['Push Images'], types: ['completed'] } }` plus job-level condition `if: github.event.workflow_run.conclusion == 'success'`.
3. In `cd.yml`, define job `deploy` on `ubuntu-latest` with permissions `contents: read` and `id-token: write`. Steps: (a) `actions/checkout@v4`, (b) `azure/login@v2` using the same OIDC secrets as the CI workflow, (c) extract the image tag by calling the GitHub API to read the `image_tag` output from the triggering `Push Images` workflow run — use `gh api /repos/${{ github.repository }}/actions/runs/${{ github.event.workflow_run.id }}/jobs` and parse the output, or more simply set the tag to the triggering workflow's `head_sha` short form using `echo "IMAGE_TAG=$(echo ${{ github.event.workflow_run.head_sha }} | cut -c1-8)" >> $GITHUB_ENV`, (d) run `az containerapp update --name ${{ secrets.CONTAINER_APP_NAME }} --resource-group ${{ secrets.AZURE_RESOURCE_GROUP }} --image ${{ secrets.ACR_NAME }}.azurecr.io/orcha:${{ env.IMAGE_TAG }}` to trigger a new revision, (e) run `az containerapp revision list --name ${{ secrets.CONTAINER_APP_NAME }} --resource-group ${{ secrets.AZURE_RESOURCE_GROUP }} --query "[0].properties.provisioningState" -o tsv` in a retry loop (max 10 attempts, 15-second sleep) until the value is `Provisioned` or fail the workflow if it becomes `Failed`.
4. Add a health check gate step: after the revision is `Provisioned`, run `curl --retry 5 --retry-delay 5 --retry-connrefused -f https://${{ secrets.ORCHA_DOMAIN }}/health` and fail the workflow if the curl command exits non-zero.
5. Add a final step that posts a GitHub deployment status using `actions/github-script@v7` to mark the deployment as `success` or `failure` with a link to the Container App URL, so deployment history is visible in the GitHub repository deployments panel.

**Key files**: .github/workflows/cd.yml, src/web/routes/health.ts

**Verification**:
```bash
curl -f https://<ORCHA_DOMAIN>/health | jq .status  # after a real deploy; or locally: npm run build && node dist/web/start-server.js & sleep 2 && curl -f http://localhost:3000/health
```

---