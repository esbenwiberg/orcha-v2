import { spawn } from 'node-pty';
import type { IPty } from 'node-pty';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { SessionTerminal, TerminalSize, PtySpawnOptions } from './session-terminal.js';
import { loadSandboxConfig } from '../sandbox/sandbox-config.js';
import { buildSandboxedCommand } from '../sandbox/bwrap.js';

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
    if (this._exitCode === undefined) {
      this._pty.write(data);
    }
  }

  resize(size: TerminalSize): void {
    const cols = Math.max(1, size.cols);
    const rows = Math.max(1, size.rows);
    this._pty.resize(cols, rows);
  }

  kill(signal = 'SIGTERM'): void {
    this._pty.kill(signal);
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
    const sandboxed = buildSandboxedCommand(
      opts.cwd,
      [opts.command, ...baseArgs],
      effectiveConfig,
      undefined,
      opts.extraRwPaths,
    );
    const [command = opts.command, ...args] = sandboxed;

    const sessionEnv = opts.env ?? {};
    const relevantEnvKeys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'CLAUDE_CODE_USE_FOUNDRY'];
    const envStatus = relevantEnvKeys.map((k) => `${k}=${sessionEnv[k] !== undefined ? 'SET' : (process.env[k] !== undefined ? 'HOST' : 'UNSET')}`).join(' ');
    console.log(`[pty] spawn sessionId=${opts.sessionId} command=${command} args=${JSON.stringify(args)} cwd=${opts.cwd} ${envStatus}`);

    // Log credential file existence when HOME is set (for Max/Pro OAuth sessions)
    const homeDir = sessionEnv['HOME'];
    if (homeDir) {
      const credsPath = join(homeDir, '.claude', '.credentials.json');
      const credsExist = existsSync(credsPath);
      console.log(`[pty] credential check sessionId=${opts.sessionId} HOME=${homeDir} credsExist=${credsExist}`);
    }

    // Build final env: merge process.env with session overrides, then delete any
    // explicitly removed keys (e.g. ANTHROPIC_API_KEY for max/pro OAuth sessions).
    const mergedEnv: Record<string, string> = { ...process.env as Record<string, string>, ...sessionEnv };
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
