import type { ChildProcess } from 'node:child_process';
import { allocatePort } from './port-allocator.js';
import { resolveConfig } from './config-resolver.js';
import type { ValidationConfig } from './config-resolver.js';
import { spawnServe, killServe } from './serve-runner.js';
import { dockerUp, dockerDown, listOrchaProjects, killOrchaProject } from './docker-runner.js';
import { execFile } from 'node:child_process';
import { BrowserManager } from './browser-manager.js';
import type { BrowseResult, ExtractResult, ConsoleEntry } from './browser-manager.js';

export type ValidationStatus = 'building' | 'starting' | 'healthy' | 'failed' | 'stopped';

export interface ValidationEnv {
  sessionId: string;
  mode: 'serve' | 'docker';
  port: number;
  url: string;
  status: ValidationStatus;
  pid?: number;
  dockerProject?: string;
  composePath?: string;
  cwd?: string;
  output: string[];
  startedAt: Date;
  timeout: number;
  timeoutTimer?: NodeJS.Timeout;
  process?: ChildProcess;
  dockerLogsProcess?: ChildProcess;
  healthTimer?: NodeJS.Timeout;
}

export interface StartParams {
  worktreePath: string;
  repoFields?: {
    validateMode?: string | null;
    validateBuild?: string | null;
    validateStart?: string | null;
    validateHealth?: string | null;
    validateComposeFile?: string | null;
    validateTimeout?: number | null;
  };
  presetFields?: {
    validateMode?: string | null;
    validateBuild?: string | null;
    validateStart?: string | null;
    validateHealth?: string | null;
    validateComposeFile?: string | null;
    validateTimeout?: number | null;
  };
  agentOverrides?: {
    mode?: string;
    build?: string;
    start?: string;
    health?: string;
    compose_file?: string;
    timeout?: number;
  };
}

export class ValidationManager {
  private _envs: Map<string, ValidationEnv> = new Map();
  private _browserManager = new BrowserManager();

  async start(
    sessionId: string,
    params: StartParams,
  ): Promise<{ url: string; port: number; status: ValidationStatus }> {
    // Stop any existing validation for this session
    if (this._envs.has(sessionId)) {
      await this.stop(sessionId);
    }

    const config = resolveConfig(
      params.worktreePath,
      params.repoFields,
      params.presetFields,
      params.agentOverrides,
    );

    if (!config) {
      throw new Error(
        'No validation config found. Set mode to "serve" or "docker" via .orcha/validate.yml, repo settings, or tool params.',
      );
    }

    const port = await allocatePort();
    const url = `http://localhost:${port}`;

    const env: ValidationEnv = {
      sessionId,
      mode: config.mode,
      port,
      url,
      status: 'building',
      output: [],
      startedAt: new Date(),
      timeout: config.timeout,
      cwd: params.worktreePath,
    };
    this._envs.set(sessionId, env);

    try {
      // Optional build step
      if (config.build) {
        env.output.push(`$ ${config.build}`);
        await this._runBuild(config.build, params.worktreePath, port, env.output);
      }

      env.status = 'starting';

      if (config.mode === 'serve') {
        await this._startServe(sessionId, config, params.worktreePath, port, env);
      } else {
        await this._startDocker(sessionId, config, params.worktreePath, port, env);
      }

      // Start health polling if a health path is configured
      if (config.health) {
        this._pollHealth(sessionId, url, config.health, env);
      } else {
        // No health check — assume healthy after a short delay
        setTimeout(() => {
          if (env.status === 'starting') env.status = 'healthy';
        }, 2000);
      }

      // Auto-timeout
      env.timeoutTimer = setTimeout(() => {
        console.log(`[validation] timeout reached for session ${sessionId} (${config.timeout}s)`);
        void this.stop(sessionId);
      }, config.timeout * 1000);

      return { url, port, status: env.status };
    } catch (err) {
      env.status = 'failed';
      env.output.push(`[error] ${String(err)}`);
      throw err;
    }
  }

  async stop(sessionId: string): Promise<{ status: 'stopped' }> {
    const env = this._envs.get(sessionId);
    if (!env) return { status: 'stopped' };

    // Close browser context for this session
    await this._browserManager.close(sessionId);

    // Clear timers
    if (env.timeoutTimer) clearTimeout(env.timeoutTimer);
    if (env.healthTimer) clearTimeout(env.healthTimer);

    if (env.mode === 'serve' && env.process) {
      await killServe(env.process);
    } else if (env.mode === 'docker' && env.dockerProject && env.composePath && env.cwd) {
      await dockerDown(env.composePath, env.cwd, env.dockerProject, env.dockerLogsProcess);
    }

    env.status = 'stopped';
    this._envs.delete(sessionId);
    console.log(`[validation] stopped for session ${sessionId}`);
    return { status: 'stopped' };
  }

  async forceStop(sessionId: string): Promise<void> {
    const env = this._envs.get(sessionId);
    if (!env) return;

    await this._browserManager.close(sessionId).catch(() => {});

    if (env.timeoutTimer) clearTimeout(env.timeoutTimer);
    if (env.healthTimer) clearTimeout(env.healthTimer);

    if (env.mode === 'serve' && env.process) {
      try { env.process.kill('SIGKILL'); } catch { /* ignore */ }
    } else if (env.mode === 'docker' && env.dockerProject && env.composePath && env.cwd) {
      await dockerDown(env.composePath, env.cwd, env.dockerProject, env.dockerLogsProcess);
    }

    env.status = 'stopped';
    this._envs.delete(sessionId);
  }

  status(sessionId: string): {
    url: string;
    port: number;
    status: ValidationStatus;
    uptime: number;
  } | undefined {
    const env = this._envs.get(sessionId);
    if (!env) return undefined;

    return {
      url: env.url,
      port: env.port,
      status: env.status,
      uptime: Math.floor((Date.now() - env.startedAt.getTime()) / 1000),
    };
  }

  logs(sessionId: string, lines: number = 50): string[] {
    const env = this._envs.get(sessionId);
    if (!env) return [];
    return env.output.slice(-lines);
  }

  // --- Browser tools (delegated to BrowserManager) ---

  async browse(
    sessionId: string,
    opts: { url?: string; path?: string; waitFor?: string },
  ): Promise<BrowseResult> {
    const env = this._envs.get(sessionId);
    if (!env) {
      throw new Error('No validation environment running. Call validate_start first.');
    }
    return this._browserManager.browse(sessionId, env.port, opts);
  }

  async screenshot(
    sessionId: string,
    opts: { fullPage?: boolean; selector?: string },
  ): Promise<Buffer> {
    if (!this._envs.has(sessionId)) {
      throw new Error('No validation environment running. Call validate_start first.');
    }
    return this._browserManager.screenshot(sessionId, opts);
  }

  async extract(
    sessionId: string,
    selector: string,
    attribute?: string,
  ): Promise<ExtractResult[]> {
    if (!this._envs.has(sessionId)) {
      throw new Error('No validation environment running. Call validate_start first.');
    }
    return this._browserManager.extract(sessionId, selector, attribute);
  }

  consoleLogs(sessionId: string, limit?: number): ConsoleEntry[] {
    return this._browserManager.getConsoleLogs(sessionId, limit);
  }

  /** Sweep orphaned docker projects with no active session. */
  async cleanup(activeSessionIds: Set<string>): Promise<void> {
    const projects = await listOrchaProjects();
    for (const project of projects) {
      // Extract session ID fragment from project name: orcha-val-{first12chars}
      const fragment = project.replace('orcha-val-', '');
      const hasActive = [...activeSessionIds].some((id) => id.startsWith(fragment));
      if (!hasActive) {
        console.log(`[validation] cleaning up orphaned docker project: ${project}`);
        await killOrchaProject(project).catch((err) => {
          console.warn(`[validation] failed to clean up ${project}:`, err);
        });
      }
    }
  }

  /** Check if a session has an active validation env. */
  has(sessionId: string): boolean {
    return this._envs.has(sessionId);
  }

  private async _runBuild(
    command: string,
    cwd: string,
    port: number,
    output: string[],
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile('sh', ['-c', command], {
        cwd,
        env: { ...process.env, PORT: String(port) },
        timeout: 120_000,
      }, (err, stdout, stderr) => {
        if (stdout) {
          for (const line of stdout.split('\n')) output.push(line);
        }
        if (stderr) {
          for (const line of stderr.split('\n')) output.push(`[stderr] ${line}`);
        }
        if (err) reject(new Error(`Build failed: ${stderr || String(err)}`));
        else resolve();
      });
    });
  }

  private async _startServe(
    sessionId: string,
    config: ValidationConfig,
    cwd: string,
    port: number,
    env: ValidationEnv,
  ): Promise<void> {
    if (!config.start) {
      throw new Error('serve mode requires a "start" command');
    }

    const serve = spawnServe(config.start, cwd, port);
    env.process = serve.process;
    env.pid = serve.pid;
    // Share output buffer reference
    env.output = serve.output;

    serve.process.on('exit', (code) => {
      if (env.status !== 'stopped') {
        env.status = 'failed';
        env.output.push(`[exit] process exited with code ${code}`);
      }
    });
  }

  private async _startDocker(
    sessionId: string,
    config: ValidationConfig,
    cwd: string,
    port: number,
    env: ValidationEnv,
  ): Promise<void> {
    const composePath = config.composeFile ?? 'docker-compose.yml';
    const docker = await dockerUp(composePath, cwd, port, sessionId);
    env.dockerProject = docker.projectName;
    env.composePath = composePath;
    env.output = docker.output;
    if (docker.logsProcess) {
      env.dockerLogsProcess = docker.logsProcess;
    }
  }

  private _pollHealth(
    sessionId: string,
    baseUrl: string,
    healthPath: string,
    env: ValidationEnv,
  ): void {
    const url = `${baseUrl}${healthPath.startsWith('/') ? healthPath : `/${healthPath}`}`;
    let attempts = 0;
    const maxAttempts = 60; // 60 * 2s = 2 min max polling

    const check = () => {
      if (env.status === 'stopped' || env.status === 'failed') return;

      attempts++;
      fetch(url, { signal: AbortSignal.timeout(5000) })
        .then((res) => {
          if (res.ok) {
            env.status = 'healthy';
            env.output.push(`[health] ${url} → ${res.status} OK`);
            console.log(`[validation] health check passed for session ${sessionId}`);
          } else if (attempts < maxAttempts) {
            env.healthTimer = setTimeout(check, 2000);
          } else {
            env.status = 'failed';
            env.output.push(`[health] ${url} → ${res.status} (gave up after ${maxAttempts} attempts)`);
          }
        })
        .catch(() => {
          if (attempts < maxAttempts && env.status !== 'stopped') {
            env.healthTimer = setTimeout(check, 2000);
          } else if (env.status !== 'stopped') {
            env.status = 'failed';
            env.output.push(`[health] ${url} → connection refused (gave up after ${maxAttempts} attempts)`);
          }
        });
    };

    // First check after 1s to give the process time to bind
    env.healthTimer = setTimeout(check, 1000);
  }
}
