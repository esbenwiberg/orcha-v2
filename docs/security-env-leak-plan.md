# Security: Env Var Leaks & Docker Socket Exposure

## Problem 1: Env var leaks into validation processes

All validation paths (`serve-runner.ts`, `docker-runner.ts`, `validation-manager.ts` build step) spread `process.env` into child processes without filtering. This leaks Orcha's host secrets:

| Leaked Variable | Risk |
|---|---|
| `AUTH_TOKEN` | Orcha API auth — full control of the dashboard |
| `SESSION_SECRET` | Session cookie signing — session hijacking |
| `ANTHROPIC_API_KEY` | LLM access — cost/abuse |
| `ANTHROPIC_AUTH_TOKEN` | Same |
| `DEVOPS_BOOTSTRAP_PAT` | Azure DevOps admin access |
| `AZURE_CLIENT_SECRET` | Azure SP secret — cloud resource access |
| `GH_TOKEN` / `GITHUB_TOKEN` | GitHub repo access |
| `DOCKER_HOST` / `DOCKER_TLS_VERIFY` / `DOCKER_CERT_PATH` | Remote Docker daemon access |

### Leak vectors

1. **serve-runner.ts:23** — `...process.env` spread into spawned serve process
2. **docker-runner.ts:47** — `...process.env` spread into `docker compose up` env (compose does `${VAR}` interpolation from shell env)
3. **docker-runner.ts:96** — `process.env` passed directly to docker logs process
4. **validation-manager.ts:280** — `...process.env` spread into build step

### Impact

- **Serve mode**: Child process runs inside Orcha's container with full env. A malicious or compromised validation app can read `/proc/self/environ` or just `echo $AUTH_TOKEN`.
- **Docker mode**: Compose services don't directly inherit the env (they have their own `environment:` block), BUT Docker Compose does shell variable substitution. Any `${VAR}` or `$VAR` in the compose file pulls from the parent env. Also, the `docker` CLI process itself sees all secrets.

## Problem 2: Docker socket exposure in serve mode

When Orcha runs locally with Docker socket mounted (`/var/run/docker.sock`), serve-mode validation spawns a child process *inside Orcha's container*. That process:

- Inherits the full filesystem (including the mounted socket)
- Can talk to Docker daemon directly: `curl --unix-socket /var/run/docker.sock http://localhost/containers/json`
- Can spin up privileged containers, escape to host

### Docker mode is safer here

Docker-mode validation runs in separate containers that DON'T have the socket mounted (compose-guard blocks it). The risk is serve-mode only.

## Fix: Validation Environment Allowlist

### Approach: allowlist, not blocklist

The current pattern of `...process.env` then deleting known-bad keys is fundamentally wrong. New secrets get added and the blocklist doesn't get updated. Flip it: **only pass explicitly allowed env vars** to validation processes.

### Safe env vars for validation

```typescript
/** Env vars safe to pass to validation child processes. */
const VALIDATION_ENV_ALLOWLIST = new Set([
  // System
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',

  // Node.js
  'NODE_ENV',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NPM_CONFIG_REGISTRY',

  // Build tools
  'CI',
  'FORCE_COLOR',
  'NO_COLOR',
  'COREPACK_ENABLE_STRICT',

  // Validation-specific (injected by us)
  'PORT',
  'ORCHA_NO_HOST_PORT',
]);
```

### Implementation

#### New file: `src/validation/env-allowlist.ts`

```typescript
export function sanitizeEnvForValidation(
  extra?: Record<string, string>,
): Record<string, string> {
  const clean: Record<string, string> = {};

  for (const key of VALIDATION_ENV_ALLOWLIST) {
    const val = process.env[key];
    if (val !== undefined) clean[key] = val;
  }

  // Merge extra vars (validation-specific overrides like PORT)
  if (extra) Object.assign(clean, extra);

  return clean;
}
```

#### Changes to `serve-runner.ts`

```diff
- env: {
-   ...process.env,
-   ...env,
-   PORT: String(port),
- },
+ env: sanitizeEnvForValidation({
+   ...env,
+   PORT: String(port),
+ }),
```

#### Changes to `docker-runner.ts`

```diff
- const composeEnv = {
-   ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)),
-   PORT: String(port),
-   ...(containerized ? { ORCHA_NO_HOST_PORT: '1' } : {}),
- } as Record<string, string>;
+ const composeEnv = sanitizeEnvForValidation({
+   PORT: String(port),
+   ...(containerized ? { ORCHA_NO_HOST_PORT: '1' } : {}),
+ });
```

Also for the logs process:
```diff
- env: process.env as Record<string, string>,
+ env: sanitizeEnvForValidation(),
```

#### Changes to `validation-manager.ts`

```diff
- env: { ...process.env, PORT: String(port) },
+ env: sanitizeEnvForValidation({ PORT: String(port) }),
```

### Docker-specific env vars for remote Docker

When remote Docker is active, we need `DOCKER_HOST`, `DOCKER_TLS_VERIFY`, and `DOCKER_CERT_PATH` in the compose env — but ONLY for the `docker` CLI process, NOT leaked into the validation containers.

Docker CLI reads these from its own process env. Compose services don't inherit the CLI's env unless they use `${DOCKER_HOST}` interpolation (which they shouldn't). So adding these to the allowlist for the docker CLI process is safe:

```typescript
// Only for docker-runner — not for serve or build
const DOCKER_CLI_EXTRA = [
  'DOCKER_HOST',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
  'DOCKER_VM_IP',
];
```

## Fix: Docker Socket Guard for Serve Mode

### Problem

Serve-mode validation runs as a child process inside Orcha's container. If docker.sock is mounted, the child process can access it.

### Options

**Option A: Block serve mode when docker.sock is present**

If `/var/run/docker.sock` exists and validation mode is `serve`, warn or block. Serve mode is for simple apps that don't need Docker — if Docker is available, use Docker mode instead.

**Option B: Sandbox serve processes with landlock**

If `SANDBOX_MODE=landlock`, wrap the serve process to restrict filesystem access. Landlock can deny access to `/var/run/docker.sock`. This requires the landlock integration to work for serve-mode too (currently only used for PTY sessions).

**Option C: Use unshare to create a mount namespace**

Before spawning the serve process, use `unshare --mount` to create a new mount namespace and unmount docker.sock. Works without landlock but requires CAP_SYS_ADMIN (which we may not have on ACA anyway — moot point there).

### Recommendation

**Option A is simplest and sufficient.** If docker.sock is mounted, you have Docker — so use Docker mode. Serve mode should be the fallback for environments without Docker. Add a warning in the validation output if we detect docker.sock during serve-mode startup.

Additionally, add `/var/run/docker.sock` to the list of paths that landlock (Option B) blocks when available, as defense in depth.

### Implementation

#### In `validation-manager.ts`, before `_startServe`:

```typescript
if (existsSync('/var/run/docker.sock')) {
  env.output.push(
    '[warn] docker.sock is accessible — serve mode runs unsandboxed. ' +
    'Consider using docker mode for better isolation.'
  );
}
```

## Testing

- Unit test `sanitizeEnvForValidation()` with mock `process.env` containing secrets
- Verify serve-runner does NOT pass `AUTH_TOKEN` etc. to child
- Verify docker-runner compose env does NOT contain secrets
- Verify build step does NOT contain secrets
- Test that `PATH`, `NODE_ENV`, `PORT` etc. DO pass through
- Test that Docker CLI vars pass through only in docker-runner context
