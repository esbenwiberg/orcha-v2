import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { sanitizeEnvForValidation } from './env-allowlist.js';

export interface ServeProcess {
  process: ChildProcess;
  pid: number;
  output: string[];
}

const MAX_OUTPUT_LINES = 500;

/**
 * Spawn a serve-mode process with PORT injected as env var.
 * Returns the child process, PID, and a reference to the output buffer.
 */
export function spawnServe(
  command: string,
  cwd: string,
  port: number,
  env?: Record<string, string>,
): ServeProcess {
  const output: string[] = [];

  if (existsSync('/var/run/docker.sock')) {
    output.push(
      '[warn] docker.sock is accessible — serve mode runs unsandboxed. ' +
      'Consider using docker mode for better isolation.',
    );
  }

  const child = spawn('sh', ['-c', command], {
    cwd,
    env: sanitizeEnvForValidation({
      ...env,
      PORT: String(port),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const pushLine = (line: string) => {
    output.push(line);
    if (output.length > MAX_OUTPUT_LINES) {
      output.splice(0, output.length - MAX_OUTPUT_LINES);
    }
  };

  let stdoutBuf = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop()!;
    for (const line of lines) pushLine(line);
  });

  let stderrBuf = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop()!;
    for (const line of lines) pushLine(`[stderr] ${line}`);
  });

  return {
    process: child,
    pid: child.pid!,
    output,
  };
}

/** Gracefully stop a serve process: SIGTERM, then SIGKILL after 5s. */
export function killServe(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // Already dead
      }
    }, 5000);

    proc.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });

    try {
      proc.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}
