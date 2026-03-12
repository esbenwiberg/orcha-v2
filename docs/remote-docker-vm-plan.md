# Remote Docker VM — Validation on ACA

## Problem

Orcha runs on Azure Container Apps (ACA). ACA has no Docker daemon — no privileged mode, no `/dev/fuse`, no DinD. But repos with multi-container setups (app + postgres/redis) need Docker Compose for validation.

## Alternatives Considered

| Option | Verdict |
|---|---|
| ACI Container Groups | Azure-native, but needs compose→ACI translator + ACR Tasks for builds. More moving parts. |
| ACA Jobs | Single-container only. Can't do app+db. |
| ACA Dynamic Sessions | Single-container only (for now). |
| Podman on ACA | Blocked — needs `/dev/fuse`. |
| DinD on ACA | Blocked — needs `--privileged`. |
| AKS | Overkill. |
| Fly.io Machines | Great API, but data leaves Azure. |
| **Remote Docker VM** | **Winner. Reuses existing docker-runner.ts almost unchanged.** |

## Solution: Remote Docker VM

A dedicated Azure VM (B1s to start) on the same VNet as ACA, running Docker CE. Orcha targets it via `DOCKER_HOST=tcp://<vm-ip>:2376` with TLS.

### Why this works

Docker CLI natively supports `DOCKER_HOST`. All existing `execFile('docker', [...])` calls in `docker-runner.ts` pass `process.env` to child processes. Set the env var and everything targets the remote daemon automatically — including build context transfer (Docker tars and sends it over the wire).

### Architecture

```
┌─────────────────────────────┐        ┌──────────────────────────────────┐
│  ACA (Orcha)                │        │  Azure VM (B1s) — same VNet      │
│                             │        │                                  │
│  validation-manager.ts      │  TCP   │  dockerd (TLS on :2376)          │
│    └─ docker-runner.ts ─────┼────────┤    ├─ orcha-val-xxx-app-1        │
│         DOCKER_HOST=tcp://… │  2376  │    ├─ orcha-val-xxx-postgres-1   │
│                             │        │    └─ orcha-val-xxx-redis-1      │
│  Playwright ────────────────┼────────┤       (published ports)          │
│         http://<vm-ip>:PORT │        │                                  │
└─────────────────────────────┘        └──────────────────────────────────┘
         Same Azure VNet — private IPs only
```

## Implementation Phases

### Phase 1: Environment Detection Refactor (`docker-env.ts`)

Split `isInsideDocker()` into granular functions:

- `isRemoteDocker()` — `DOCKER_HOST` env var is set
- `isDockerAvailable()` — local socket exists OR `DOCKER_HOST` is set
- `canJoinDockerNetwork()` — local Docker AND we have our own container ID (NOT remote)
- `getDockerVmIp()` — parse IP from `DOCKER_HOST` or fall back to `DOCKER_VM_IP` env var

### Phase 2: Docker Runner Changes (`docker-runner.ts`)

In `dockerUp()`, replace `isInsideDocker()` with `canJoinDockerNetwork()` for the network-attach logic. Add a new path:

```
if canJoinDockerNetwork() → attach to bridge network, use service hostname
elif isRemoteDocker()     → use VM IP + published port (no network attach)
else                      → localhost + published port (local dev)
```

All `execFile('docker', ...)` calls already inherit `process.env`, so `DOCKER_HOST` flows through automatically. No changes needed for `dockerDown`, `listOrchaProjects`, or `killOrchaProject`.

### Phase 3: URL Fix (`validation-manager.ts`)

When remote Docker is active, `env.url` should use the VM IP instead of `localhost`.

### Phase 4: TLS Certs

- Store client certs on Azure File Share at `/data/docker-tls/`
- Set `DOCKER_TLS_VERIFY=1` and `DOCKER_CERT_PATH=/data/docker-tls` on ACA
- Generate server+client certs during VM setup

### Phase 5: Infrastructure

- `infra/modules/docker-vm.bicep` — B1s Ubuntu VM, Docker CE, TLS, NSG (port 2376 from ACA subnet only)
- `infra/cloud-init-docker.yml` — cloud-init to install Docker + configure TLS
- `scripts/setup-docker-vm.sh` — one-time provisioning + cert retrieval

### Phase 6: Compose Guard (`compose-guard.ts`)

Warn (not block) about bind mount volumes when remote Docker is active — `./src:/app/src` style mounts won't work because the files aren't on the VM. Only `build:` directives work (context sent over the wire).

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DOCKER_HOST` | _(unset)_ | Remote Docker daemon, e.g. `tcp://10.0.1.4:2376` |
| `DOCKER_TLS_VERIFY` | _(unset)_ | Set to `1` for TLS |
| `DOCKER_CERT_PATH` | _(unset)_ | Path to ca.pem, cert.pem, key.pem |
| `DOCKER_VM_IP` | _(parsed from DOCKER_HOST)_ | Explicit VM IP override for reaching published ports |

## Environment Detection Matrix

| Scenario | `isInsideDocker()` | `isRemoteDocker()` | `canJoinDockerNetwork()` | Networking |
|---|---|---|---|---|
| Local dev (no Docker) | false | false | false | serve mode only |
| Local dev (Docker) | false | false | false | localhost + port |
| Orcha in Docker (local daemon) | true | false | true | bridge network + service hostname |
| ACA + remote Docker VM | true | true | false | VM IP + published port |

## VM Sizing

| VM | RAM | Concurrent stacks | Cost/mo |
|---|---|---|---|
| **B1s (start here)** | **1 GB** | **1** | **~$4** |
| B2s (scale up if needed) | 4 GB | 2-3 | ~$30 |
| B2ms | 8 GB | 4-5 | ~$60 |

## Gotchas

1. **Bind mounts don't work** — `volumes: ["./src:/app/src"]` fails with remote Docker. Only `build:` contexts are sent over the wire.
2. **Port collisions** — `allocatePort()` picks a free port on ACA, but the VM might already have that port in use. Low risk with ephemeral ports, but handle the error.
3. **Build context size** — Large worktrees get tarred and sent over TCP. `.dockerignore` matters more with remote Docker.
4. **B1s limits** — 1GB RAM, 10% sustained CPU. One concurrent stack max. Resize to B2s when needed.
