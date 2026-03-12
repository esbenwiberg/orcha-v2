import { spawn } from 'node-pty';
import type { IPty } from 'node-pty';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { SessionTerminal, TerminalSize, PtySpawnOptions } from './session-terminal.js';
import { loadSandboxConfig } from '../sandbox/sandbox-config.js';
import { buildSandboxedCommand } from '../sandbox/sandbox-command.js';

export class PtyError extends Error {
  code: 'ALREADY_EXISTS' | 'SPAWN_FAILED' | 'NOT_FOUND';

  constructor(message: string, code: 'ALREADY_EXISTS' | 'SPAWN_FAILED' | 'NOT_FOUND') {
    super(message);
    this.name = 'PtyError';
    this.code = code;
  }
}

class PtySessionTerminal extends EventEmitter implements SessionTerminal {
  readonly sessionId: string;
  private readonly _pty: IPty;
  private _outputStream: Readable | undefined;
  private _exitCode: number | undefined;

  constructor(sessionId: string, pty: IPty) {
    super();
    this.sessionId = sessionId;
    this._pty = pty;

    this._pty.onExit(({ exitCode, signal }) => {
      this._exitCode = exitCode;
      this._outputStream?.push(null);
      this.emit('exit', exitCode, signal !== undefined ? String(signal) : '');
    });
  }

  get pid(): number | undefined {
    return this._pty.pid;
  }

  get exitCode(): number | undefined {
    return this._exitCode;
  }

  get output(): NodeJS.ReadableStream {
    if (this._outputStream === undefined) {
      const readable = new Readable({ read() {} });
      let firstDataLogged = false;
      this._pty.onData((data) => {
        if (!firstDataLogged) {
          firstDataLogged = true;
          console.log(`[pty] first raw data sessionId=${this.sessionId} bytes=${data.length}`);
        }
        readable.push(data);
      });
      this._outputStream = readable;
    }
    return this._outputStream;
  }

  write(data: string): void {
    if (this._exitCode !== undefined) return;
    try {
      this._pty.write(data);
    } catch (err) {
      // PTY fd may close between the exitCode check and the native call.
      process.stderr.write(`[pty] write failed sessionId=${this.sessionId}: ${String(err)}\n`);
    }
  }

  resize(size: TerminalSize): void {
    if (this._exitCode !== undefined) return;
    const cols = Math.max(1, size.cols);
    const rows = Math.max(1, size.rows);
    try {
      this._pty.resize(cols, rows);
    } catch (err) {
      // PTY fd may close between the exitCode check and the native ioctl call.
      // Without this catch, EBADF from node-pty kills the process.
      process.stderr.write(`[pty] resize failed sessionId=${this.sessionId}: ${String(err)}\n`);
    }
  }

  kill(signal = 'SIGTERM'): void {
    try {
      this._pty.kill(signal);
    } catch {
      // Already dead
    }
  }
}

export class PtyManager {
  private _sessions: Map<string, PtySessionTerminal> = new Map();
  private readonly _sandboxConfig = loadSandboxConfig();

  spawn(opts: PtySpawnOptions): SessionTerminal {
    if (this._sessions.has(opts.sessionId)) {
      throw new PtyError(
        `Session '${opts.sessionId}' already exists`,
        'ALREADY_EXISTS',
      );
    }

    // Apply sandbox wrapping if enabled globally and not opted out per-session
    const baseArgs = opts.args ?? [];
    const sandboxActive = this._sandboxConfig.enabled && (opts.sandbox !== false);
    const effectiveConfig = sandboxActive
      ? this._sandboxConfig
      : { ...this._sandboxConfig, enabled: false };
    // Pass session HOME so landlock-exec grants RW access to ~/.claude/
    const sessionHome = opts.env?.['HOME'];
    const sandboxed = buildSandboxedCommand(
      opts.cwd,
      [opts.command, ...baseArgs],
      effectiveConfig,
      sessionHome,
      opts.extraRwPaths,
    );
    const [command = opts.command, ...args] = sandboxed;

    const sessionEnv = opts.env ?? {};
    const relevantEnvKeys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_USE_FOUNDRY'];
    const mask = (k: string, v: string | undefined): string => {
      if (v === undefined) return 'UNSET';
      if (v === '') return 'EMPTY';
      if (k.includes('KEY') || k.includes('TOKEN')) return `${v.slice(0, 3)}***[${v.length}]`;
      return v;
    };
    const envStatus = relevantEnvKeys.map((k) => {
      const sessionVal = sessionEnv[k];
      const hostVal = process.env[k];
      const source = sessionVal !== undefined ? 'session' : (hostVal !== undefined ? 'host' : 'none');
      const val = sessionVal ?? hostVal;
      return `${k}=${mask(k, val)}(${source})`;
    }).join(' ');
    const baseUrl = sessionEnv['ANTHROPIC_BASE_URL'] ?? process.env['ANTHROPIC_BASE_URL'] ?? '';
    const model = sessionEnv['ANTHROPIC_MODEL'] ?? process.env['ANTHROPIC_MODEL'] ?? '';
    console.log(`[pty] spawn sessionId=${opts.sessionId} command=${command} args=${JSON.stringify(args)} cwd=${opts.cwd} ${envStatus} baseUrl=${baseUrl} model=${model}`);

    // Log credential file existence when HOME is set (for Max/Pro OAuth sessions)
    const homeDir = sessionEnv['HOME'];
    if (homeDir) {
      const credsPath = join(homeDir, '.claude', '.credentials.json');
      const credsExist = existsSync(credsPath);
      console.log(`[pty] credential check sessionId=${opts.sessionId} HOME=${homeDir} credsExist=${credsExist}`);
    }

    // Default env vars to cap child-process memory usage (e.g. dotnet build,
    // npm install). Lowest priority — process.env and session overrides win.
    const memoryDefaults: Record<string, string> = {
      // Cap .NET GC heap to 512 MB — prevents dotnet build from eating the container
      DOTNET_GCHeapHardLimit: '0x20000000',
      // Kill persistent MSBuild/Roslyn compiler servers that linger between builds
      DOTNET_CLI_DO_NOT_USE_MSBUILD_SERVER: '1',
      // Disable .NET diagnostic pipes (reduces background memory + /tmp churn)
      DOTNET_EnableDiagnostics: '0',
    };

    // Build final env: memory defaults < process.env < session overrides, then
    // delete any explicitly removed keys (e.g. ANTHROPIC_API_KEY for max/pro OAuth sessions).
    const mergedEnv: Record<string, string> = { ...memoryDefaults, ...process.env as Record<string, string>, ...sessionEnv };
    for (const key of opts.deleteEnv ?? []) {
      delete mergedEnv[key];
    }

    const pty = spawn(command, args, {
      name: 'xterm-256color',
      cols: opts.size?.cols ?? 80,
      rows: opts.size?.rows ?? 24,
      cwd: opts.cwd,
      env: mergedEnv,
    });
    console.log(`[pty] spawned pid=${pty.pid}`);

    const session = new PtySessionTerminal(opts.sessionId, pty);

    session.on('exit', () => {
      this._sessions.delete(opts.sessionId);
    });

    this._sessions.set(opts.sessionId, session);
    return session;
  }

  get(sessionId: string): SessionTerminal | undefined {
    return this._sessions.get(sessionId);
  }

  async killAll(signal = 'SIGTERM'): Promise<void> {
    for (const session of this._sessions.values()) {
      session.kill(signal);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 2000));
  }
}
