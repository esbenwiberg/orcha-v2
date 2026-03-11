import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

export interface ComposeViolation {
  service: string;
  issue: string;
}

/** Volume mount paths that are dangerous to expose to untrusted containers. */
const DANGEROUS_VOLUMES = [
  '/var/run/docker.sock',
  '/var/run/docker',
  '/etc/shadow',
  '/etc/passwd',
  '/root',
  '/proc',
  '/sys',
];

/** Capabilities that grant near-root access. */
const DANGEROUS_CAPS = new Set([
  'SYS_ADMIN',
  'SYS_PTRACE',
  'NET_ADMIN',
  'ALL',
]);

/**
 * Scan a docker-compose file for security-sensitive configurations.
 * Returns a list of violations. Empty list = safe to run.
 */
export function auditComposeFile(composePath: string): ComposeViolation[] {
  const violations: ComposeViolation[] = [];

  let doc: Record<string, unknown>;
  try {
    const raw = readFileSync(composePath, 'utf8');
    doc = yaml.load(raw) as Record<string, unknown>;
  } catch (err) {
    return [{ service: '(file)', issue: `Failed to parse compose file: ${String(err)}` }];
  }

  if (!doc || typeof doc !== 'object') {
    return [{ service: '(file)', issue: 'Compose file is empty or not an object' }];
  }

  const services = doc['services'] as Record<string, Record<string, unknown>> | undefined;
  if (!services || typeof services !== 'object') return violations;

  for (const [name, svc] of Object.entries(services)) {
    if (!svc || typeof svc !== 'object') continue;

    // Check privileged mode
    if (svc['privileged'] === true) {
      violations.push({ service: name, issue: 'privileged: true — grants full host access' });
    }

    // Check network_mode: host
    if (svc['network_mode'] === 'host') {
      violations.push({ service: name, issue: 'network_mode: host — shares host network stack' });
    }

    // Check pid: host
    if (svc['pid'] === 'host') {
      violations.push({ service: name, issue: 'pid: host — can see and signal host processes' });
    }

    // Check ipc: host
    if (svc['ipc'] === 'host') {
      violations.push({ service: name, issue: 'ipc: host — shares host IPC namespace' });
    }

    // Check volumes for dangerous mounts
    const volumes = svc['volumes'];
    if (Array.isArray(volumes)) {
      for (const vol of volumes) {
        const volStr = typeof vol === 'string' ? vol : (vol as Record<string, unknown>)?.['source'] as string | undefined;
        if (!volStr) continue;

        for (const dangerous of DANGEROUS_VOLUMES) {
          if (volStr.includes(dangerous)) {
            violations.push({ service: name, issue: `volume mount "${volStr}" exposes ${dangerous}` });
          }
        }
      }
    }

    // Check cap_add for dangerous capabilities
    const capAdd = svc['cap_add'];
    if (Array.isArray(capAdd)) {
      for (const cap of capAdd) {
        if (typeof cap === 'string' && DANGEROUS_CAPS.has(cap.toUpperCase())) {
          violations.push({ service: name, issue: `cap_add: ${cap} — grants elevated privileges` });
        }
      }
    }

    // Check security_opt for apparmor/seccomp disabling
    const securityOpt = svc['security_opt'];
    if (Array.isArray(securityOpt)) {
      for (const opt of securityOpt) {
        if (typeof opt === 'string' && (opt.includes('unconfined') || opt.includes('no-new-privileges:false'))) {
          violations.push({ service: name, issue: `security_opt: "${opt}" — weakens container isolation` });
        }
      }
    }
  }

  return violations;
}

/**
 * Audit a compose file and throw if violations are found.
 * Returns a formatted error message listing all issues.
 */
export function enforceComposeGuard(composePath: string): void {
  const violations = auditComposeFile(composePath);
  if (violations.length === 0) return;

  const lines = violations.map(
    (v) => `  - [${v.service}] ${v.issue}`,
  );
  throw new Error(
    `Compose file rejected — security violations found:\n${lines.join('\n')}\n\n` +
    'These configurations could compromise host isolation. ' +
    'Remove them from the compose file and try again.',
  );
}
