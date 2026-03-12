import { execFile, type ChildProcess, spawn } from 'node:child_process';
import { join, isAbsolute } from 'node:path';
import { getOwnContainerId, isRemoteDocker, canJoinDockerNetwork, getDockerVmIp, networkConnect, networkDisconnect } from './docker-env.js';
import { enforceComposeGuard } from './compose-guard.js';
import { sanitizeEnvForDocker } from './env-allowlist.js';

const MAX_OUTPUT_LINES = 500;

export interface DockerEnv {
  projectName: string;
  networkName: string;
  output: string[];
  logsProcess?: ChildProcess;
  /** The hostname Orcha should use to reach the first compose service. */
  serviceHost: string;
  /** The internal (container) port of the first compose service. */
  servicePort: number;
  /** Whether Orcha joined the compose network (needs disconnect on teardown). */
  orchaAttached: boolean;
}

/**
 * Start a docker compose project for validation.
 *
 * When Orcha itself runs inside Docker, we attach Orcha's container to the
 * compose project's default network so Playwright can reach the validation
 * container directly — no host port publishing required.
 *
 * When running outside Docker (local dev), we fall back to port publishing
 * on the host.
 */
export async function dockerUp(
  composePath: string,
  cwd: string,
  port: number,
  sessionId: string,
  internalPort: number = 3000,
): Promise<DockerEnv> {
  const absComposePath = isAbsolute(composePath) ? composePath : join(cwd, composePath);
  const warnings = enforceComposeGuard(absComposePath);

  const projectName = `orcha-val-${sessionId.slice(0, 12)}`;
  const networkName = `${projectName}_default`;
  const output: string[] = [];

  // Surface non-blocking warnings (e.g., bind mount issues with remote Docker)
  for (const w of warnings) {
    output.push(`[warn] ${w}`);
  }
  const joinable = canJoinDockerNetwork();

  const composeEnv = sanitizeEnvForDocker({
    PORT: String(port),
    // Tell compose not to publish ports when Orcha can join the network directly —
    // we'll talk on the bridge network. Remote Docker always needs published ports.
    ...(joinable ? { ORCHA_NO_HOST_PORT: '1' } : {}),
  });

  await execFilePromise('docker', [
    'compose',
    '-p', projectName,
    '-f', composePath,
    'up', '-d',
  ], { cwd, env: composeEnv });

  // Determine the service name (first service in the compose project)
  const serviceName = await getFirstServiceName(projectName, composePath, cwd);

  // Determine how Orcha reaches the validation containers.
  // Three modes:
  //   1. canJoinDockerNetwork() → attach to bridge network, use service hostname
  //   2. isRemoteDocker()      → VM IP + published port (containers live on the VM)
  //   3. else                  → localhost + published port (local dev)
  let orchaAttached = false;
  let serviceHost: string;
  let servicePort: number;

  if (joinable) {
    const ownContainerId = getOwnContainerId();
    if (ownContainerId) {
      try {
        await networkConnect(networkName, ownContainerId);
        orchaAttached = true;
        serviceHost = serviceName;
        servicePort = internalPort;
        output.push(`[docker] attached Orcha to network ${networkName}, browsing via ${serviceName}:${internalPort}`);
      } catch (err) {
        output.push(`[docker] failed to attach to network: ${String(err)}, falling back to host port`);
        serviceHost = 'host.docker.internal';
        servicePort = port;
      }
    } else {
      // Shouldn't happen (canJoinDockerNetwork checks for container ID), but be safe
      serviceHost = 'localhost';
      servicePort = port;
    }
  } else if (isRemoteDocker()) {
    const vmIp = getDockerVmIp();
    if (vmIp) {
      serviceHost = vmIp;
      servicePort = port;
      output.push(`[docker] remote Docker — browsing via ${vmIp}:${port}`);
    } else {
      // DOCKER_HOST is set but we can't parse an IP — this is a config problem
      throw new Error(
        'Remote Docker detected (DOCKER_HOST is set) but cannot determine VM IP. ' +
        'Set DOCKER_VM_IP explicitly or use tcp://IP:PORT format for DOCKER_HOST.',
      );
    }
  } else {
    // Local dev — access via published host port
    serviceHost = 'localhost';
    servicePort = port;
  }

  // Start a logs follower in the background
  const logsProcess = spawn('docker', [
    'compose', '-p', projectName, '-f', composePath, 'logs', '-f', '--no-color',
  ], {
    cwd,
    env: sanitizeEnvForDocker(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const pushLine = (line: string) => {
    output.push(line);
    if (output.length > MAX_OUTPUT_LINES) {
      output.splice(0, output.length - MAX_OUTPUT_LINES);
    }
  };

  let stdoutBuf = '';
  logsProcess.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop()!;
    for (const line of lines) pushLine(line);
  });

  let stderrBuf = '';
  logsProcess.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop()!;
    for (const line of lines) pushLine(`[stderr] ${line}`);
  });

  return { projectName, networkName, output, logsProcess, serviceHost, servicePort, orchaAttached };
}

/** Tear down a docker compose project and clean up network attachments. */
export async function dockerDown(
  composePath: string,
  cwd: string,
  projectName: string,
  logsProcess?: ChildProcess,
  networkName?: string,
  orchaAttached?: boolean,
): Promise<void> {
  // Kill logs follower first
  if (logsProcess && logsProcess.exitCode === null) {
    try { logsProcess.kill('SIGTERM'); } catch { /* ignore */ }
  }

  // Detach Orcha from the compose network before tearing down
  if (orchaAttached && networkName) {
    const ownId = getOwnContainerId();
    if (ownId) {
      await networkDisconnect(networkName, ownId);
    }
  }

  await execFilePromise('docker', [
    'compose',
    '-p', projectName,
    '-f', composePath,
    'down', '-v', '--remove-orphans',
  ], { cwd });
}

/** List running docker compose projects matching the orcha-val- prefix. */
export async function listOrchaProjects(): Promise<string[]> {
  try {
    const stdout = await execFilePromise('docker', [
      'compose', 'ls', '--format', 'json',
    ]);
    const projects = JSON.parse(stdout) as Array<{ Name: string }>;
    return projects
      .filter((p) => p.Name.startsWith('orcha-val-'))
      .map((p) => p.Name);
  } catch {
    return [];
  }
}

/** Kill an orphaned docker compose project by name. */
export async function killOrchaProject(projectName: string): Promise<void> {
  await execFilePromise('docker', [
    'compose', '-p', projectName, 'down', '-v', '--remove-orphans',
  ]);
}

/** Get the name of the first service in a compose project. */
async function getFirstServiceName(
  projectName: string,
  composePath: string,
  cwd: string,
): Promise<string> {
  try {
    const stdout = await execFilePromise('docker', [
      'compose', '-p', projectName, '-f', composePath, 'config', '--services',
    ], { cwd });
    const first = stdout.trim().split('\n')[0];
    if (first) return `${projectName}-${first}-1`;
  } catch { /* ignore */ }

  // Fallback: use project name pattern
  return `${projectName}-app-1`;
}

function execFilePromise(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      cwd: opts?.cwd,
      env: opts?.env ?? sanitizeEnvForDocker(),
      timeout: 120_000,
    }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || stdout?.trim() || String(err);
        reject(new Error(msg));
      } else {
        resolve(stdout);
      }
    });
  });
}
