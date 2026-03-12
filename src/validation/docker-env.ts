import { readFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';

let _cachedContainerId: string | null | undefined;

/**
 * Detect whether we are running inside a Docker container.
 * Returns the container ID if so, null otherwise.
 * Result is cached after first call.
 */
export function getOwnContainerId(): string | null {
  if (_cachedContainerId !== undefined) return _cachedContainerId;

  _cachedContainerId = detectContainerId();
  return _cachedContainerId;
}

function detectContainerId(): string | null {
  // Method 1: /.dockerenv exists (most Docker setups)
  if (!existsSync('/.dockerenv')) return null;

  // Method 2: Read container ID from /proc/self/mountinfo
  // Look for the overlay mount on / — the container ID is in the path
  try {
    const mountinfo = readFileSync('/proc/self/mountinfo', 'utf8');
    for (const line of mountinfo.split('\n')) {
      // Look for docker overlay paths like /var/lib/docker/containers/<id>/...
      const match = line.match(/\/docker\/containers\/([a-f0-9]{64})\//);
      if (match?.[1]) return match[1];
    }
  } catch { /* ignore */ }

  // Method 3: hostname is often the short container ID
  try {
    const hostname = readFileSync('/etc/hostname', 'utf8').trim();
    if (/^[a-f0-9]{12,64}$/.test(hostname)) return hostname;
  } catch { /* ignore */ }

  // We know we're in Docker (/.dockerenv exists) but can't find the ID.
  // Return a sentinel so callers know we're containerized.
  return null;
}

/** Check if we're running inside a Docker container. */
export function isInsideDocker(): boolean {
  return existsSync('/.dockerenv');
}

/**
 * Check if Docker commands target a remote daemon (DOCKER_HOST is set to tcp://).
 * When true, we can't attach to compose networks — containers live on the VM, not here.
 */
export function isRemoteDocker(): boolean {
  const host = process.env['DOCKER_HOST'];
  return !!host && host.startsWith('tcp://');
}

/**
 * Check if we can join a Docker compose network directly.
 * Requires: running inside Docker locally (not remote) AND we can find our container ID.
 * False when DOCKER_HOST points to a remote VM — the network is over there, not here.
 */
export function canJoinDockerNetwork(): boolean {
  if (isRemoteDocker()) return false;
  if (!isInsideDocker()) return false;
  return getOwnContainerId() !== null;
}

/**
 * Get the IP of the remote Docker VM for reaching published ports.
 * Prefers explicit DOCKER_VM_IP env var, falls back to parsing DOCKER_HOST.
 * Returns null if not using remote Docker.
 */
export function getDockerVmIp(): string | null {
  const explicit = process.env['DOCKER_VM_IP'];
  if (explicit) return explicit;

  const host = process.env['DOCKER_HOST'];
  if (!host) return null;

  // Parse tcp://10.0.1.4:2376 → 10.0.1.4
  try {
    const url = new URL(host);
    return url.hostname || null;
  } catch {
    return null;
  }
}

/**
 * Attach a container to a Docker network.
 * No-op if already attached (docker returns error which we ignore).
 */
export async function networkConnect(
  networkName: string,
  containerId: string,
): Promise<void> {
  await execFilePromise('docker', ['network', 'connect', networkName, containerId])
    .catch((err) => {
      // "already exists in network" is fine
      if (String(err).includes('already exists')) return;
      throw err;
    });
}

/** Disconnect a container from a Docker network. Swallows errors. */
export async function networkDisconnect(
  networkName: string,
  containerId: string,
): Promise<void> {
  await execFilePromise('docker', ['network', 'disconnect', networkName, containerId])
    .catch(() => { /* ignore — container may already be detached */ });
}

function execFilePromise(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr?.trim() || stdout?.trim() || String(err)));
      } else {
        resolve(stdout);
      }
    });
  });
}
