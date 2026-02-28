import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node-pty';
import type { IPty } from 'node-pty';
import { Readable } from 'node:stream';
import { OutputBuffer } from './output-buffer.js';

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

  startSession(configId: string): string {
    const token = randomUUID();
    const cwd = `/tmp/orcha-auth-${configId}`;
    mkdirSync(cwd, { recursive: true });

    // Use the real home dir (os.homedir reads /etc/passwd; process.env.HOME
    // may be /root in Docker even when the process runs as a non-root user).
    const home = homedir();
    const claudeDir = join(home, '.claude');
    mkdirSync(claudeDir, { recursive: true });

    // Ensure a settings.json exists so claude doesn't stall on first-run wizard.
    const settingsPath = join(claudeDir, 'settings.json');
    if (!existsSync(settingsPath)) {
      writeFileSync(settingsPath, '{}', 'utf8');
    }

    // Spawn via landlock-exec exactly as regular sessions do.
    // This grants RW access to cwd and home/.claude, which claude needs to start.
    const pty = spawn('landlock-exec', [cwd, home, '--', 'claude'], {
      name: 'xterm-256color',
      cols: 120,
      rows: 24,
      cwd,
      env: { ...process.env, HOME: home },
    });

    const outputBuffer = new OutputBuffer();
    const outputStream = new Readable({ read() {} });

    let bytesReceived = 0;
    let loginSent = false;
    console.log(`[auth-pty] spawned pid=${pty.pid} configId=${configId} token=${token.slice(0, 8)} home=${home}`);

    pty.onData((data) => {
      bytesReceived += data.length;
      if (bytesReceived <= data.length) {
        console.log(`[auth-pty] first data token=${token.slice(0, 8)} bytes=${data.length}`);
        // Claude is rendering — send /login after a short delay to let the UI settle.
        if (!loginSent) {
          loginSent = true;
          setTimeout(() => {
            try {
              pty.write('/login\r');
              console.log(`[auth-pty] sent /login token=${token.slice(0, 8)}`);
            } catch { /* process may have exited */ }
          }, 800);
        }
      }
      outputBuffer.push(data);
      outputStream.push(data);
    });

    // Fallback: if claude hasn't produced output in 4s, send /login anyway.
    setTimeout(() => {
      if (!loginSent) {
        loginSent = true;
        try {
          pty.write('/login\r');
          console.log(`[auth-pty] sent /login (fallback) token=${token.slice(0, 8)} bytesReceived=${bytesReceived}`);
        } catch { /* process may have exited */ }
      }
    }, 4000);

    pty.onExit(({ exitCode }) => {
      console.log(`[auth-pty] exit token=${token.slice(0, 8)} exitCode=${exitCode} totalBytes=${bytesReceived}`);
      const entry = this._sessions.get(token);
      if (entry !== undefined) {
        entry.exitCode = exitCode;
      }
      outputStream.push(null);
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
