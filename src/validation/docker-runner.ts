import { execFile, type ChildProcess, spawn } from 'node:child_process';

const MAX_OUTPUT_LINES = 500;

export interface DockerEnv {
  projectName: string;
  output: string[];
  logsProcess?: ChildProcess;
}

/**
 * Start a docker compose project for validation.
 * Injects PORT as an env variable for compose file interpolation.
 */
export async function dockerUp(
  composePath: string,
  cwd: string,
  port: number,
  sessionId: string,
): Promise<DockerEnv> {
  const projectName = `orcha-val-${sessionId.slice(0, 12)}`;
  const output: string[] = [];

  await execFilePromise('docker', [
    'compose',
    '-p', projectName,
    '-f', composePath,
    'up', '-d',
  ], {
    cwd,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)),
      PORT: String(port),
    } as Record<string, string>,
  });

  // Start a logs follower in the background
  const logsProcess = spawn('docker', [
    'compose', '-p', projectName, '-f', composePath, 'logs', '-f', '--no-color',
  ], {
    cwd,
    env: process.env as Record<string, string>,
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

  return { projectName, output, logsProcess };
}

/** Tear down a docker compose project. */
export async function dockerDown(
  composePath: string,
  cwd: string,
  projectName: string,
  logsProcess?: ChildProcess,
): Promise<void> {
  // Kill logs follower first
  if (logsProcess && logsProcess.exitCode === null) {
    try { logsProcess.kill('SIGTERM'); } catch { /* ignore */ }
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

function execFilePromise(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      cwd: opts?.cwd,
      env: opts?.env ?? (process.env as Record<string, string>),
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
