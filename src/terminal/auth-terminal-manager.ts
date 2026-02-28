import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawn } from 'node-pty';
import type { IPty } from 'node-pty';
import { Readable } from 'node:stream';
import { OutputBuffer } from './output-buffer.js';

/**
 * A lightweight session entry for auth PTY sessions.
 * Exposes the same shape that the WS handler expects:
 *   session.terminal.output (readable stream)
 *   session.terminal.exitCode
 *   session.terminal.write(data)
 *   session.terminal.resize({ cols, rows })
 *   session.outputBuffer
 */
export interface AuthSession {
  token: string;
  configId: string;
  terminal: {
    output: NodeJS.ReadableStream;
    exitCode: number | undefined;
    write(data: string): void;
    resize(size: { cols: number; rows: number }): void;
    kill(signal?: string): void;
  };
  outputBuffer: OutputBuffer;
}

interface InternalAuthSession {
  token: string;
  configId: string;
  pty: IPty;
  outputStream: Readable;
  exitCode: number | undefined;
  outputBuffer: OutputBuffer;
}

export class AuthTerminalManager {
  private _sessions: Map<string, InternalAuthSession> = new Map();

  /**
   * Spawn a `claude` process in a temporary directory for OAuth authentication.
   * Returns a token that can be used to look up the session.
   */
  startSession(configId: string): string {
    const token = randomUUID();
    const cwd = `/tmp/orcha-auth-${configId}`;
    mkdirSync(cwd, { recursive: true });

    const pty = spawn('claude', [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 24,
      cwd,
      // os.homedir() reads /etc/passwd for the real home dir.
      // process.env.HOME may be /root in Docker when USER is switched.
      env: { ...process.env, HOME: homedir() },
    });

    // Once claude's REPL is ready, automatically trigger the login flow.
    // 1.5 s gives the process time to render its startup UI.
    setTimeout(() => {
      try {
        pty.write('/login\r');
        console.log(`[auth-pty] sent /login token=${token.slice(0, 8)} bytesReceivedSoFar=${bytesReceived}`);
      } catch { /* process may have exited */ }
    }, 1500);

    const outputBuffer = new OutputBuffer();
    const outputStream = new Readable({ read() {} });

    let bytesReceived = 0;
    console.log(`[auth-pty] spawned pid=${pty.pid} configId=${configId} token=${token.slice(0, 8)}`);

    pty.onData((data) => {
      bytesReceived += data.length;
      if (bytesReceived <= data.length) {
        console.log(`[auth-pty] first data token=${token.slice(0, 8)} bytes=${data.length} preview=${JSON.stringify(data.slice(0, 80))}`);
      }
      outputBuffer.push(data);
      outputStream.push(data);
    });

    pty.onExit(({ exitCode }) => {
      console.log(`[auth-pty] exit token=${token.slice(0, 8)} exitCode=${exitCode} totalBytes=${bytesReceived}`);
      const entry = this._sessions.get(token);
      if (entry !== undefined) {
        entry.exitCode = exitCode;
      }
      outputStream.push(null);
      // Auto-cleanup after exit
      setTimeout(() => this._sessions.delete(token), 60_000);
    });

    const entry: InternalAuthSession = {
      token,
      configId,
      pty,
      outputStream,
      exitCode: undefined,
      outputBuffer,
    };
    this._sessions.set(token, entry);

    return token;
  }

  /**
   * Returns a session view compatible with the WS handler expectations.
   */
  getSession(token: string): AuthSession | undefined {
    const entry = this._sessions.get(token);
    if (entry === undefined) return undefined;

    return {
      token: entry.token,
      configId: entry.configId,
      terminal: {
        output: entry.outputStream,
        get exitCode() {
          return entry.exitCode;
        },
        write(data: string) {
          if (entry.exitCode === undefined) {
            entry.pty.write(data);
          }
        },
        resize(size: { cols: number; rows: number }) {
          entry.pty.resize(Math.max(1, size.cols), Math.max(1, size.rows));
        },
        kill(signal = 'SIGTERM') {
          entry.pty.kill(signal);
        },
      },
      outputBuffer: entry.outputBuffer,
    };
  }

  /**
   * Kill and remove a session.
   */
  stopSession(token: string): void {
    const entry = this._sessions.get(token);
    if (entry === undefined) return;
    try {
      entry.pty.kill('SIGTERM');
    } catch {
      // Already dead
    }
    this._sessions.delete(token);
  }
}
