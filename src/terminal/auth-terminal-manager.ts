import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node-pty';
import type { IPty } from 'node-pty';
import { Readable } from 'node:stream';
import { OutputBuffer } from './output-buffer.js';

// Strip ANSI escape sequences from a string so URL extraction works on raw PTY output.
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

export function extractAuthUrl(snapshot: Buffer): string | undefined {
  const text = stripAnsi(snapshot.toString('utf8'));
  const match = /https:\/\/claude\.ai\/oauth\/authorize\S+/.exec(text)
    ?? /https:\/\/[^\s\r\n"'<>]+auth[^\s\r\n"'<>]*/i.exec(text)
    ?? /https:\/\/[^\s\r\n"'<>]{40,}/.exec(text);
  return match?.[0];
}

export interface AuthSession {
  token: string;
  configId: string;
  homeDir: string;
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
  homeDir: string;
  pty: IPty;
  outputStream: Readable;
  exitCode: number | undefined;
  outputBuffer: OutputBuffer;
}

export class AuthTerminalManager {
  private _sessions: Map<string, InternalAuthSession> = new Map();

  startSession(configId: string): string {
    const token = randomUUID();

    // Per-session worktree: a fresh git repo so claude starts with a project context.
    const cwd = `/tmp/orcha-auth-${token}`;
    mkdirSync(cwd, { recursive: true });
    try {
      execSync('git init', { cwd, stdio: 'ignore' });
    } catch {
      // Best-effort; claude may still work without a git repo
    }

    // Per-session isolated HOME so credentials land in a known location and
    // don't interfere with shared state or other concurrent auth sessions.
    const home = `/tmp/orcha-auth-home-${token}`;
    const claudeDir = join(home, '.claude');
    mkdirSync(claudeDir, { recursive: true });

    // Seed settings.json — merge shared settings (if any) with a pre-set theme
    // so claude doesn't show the first-run theme picker in the auth terminal.
    const sharedSettings = join(homedir(), '.claude', 'settings.json');
    const sessionSettings = join(claudeDir, 'settings.json');
    let baseSettings: Record<string, unknown> = {};
    if (existsSync(sharedSettings)) {
      try {
        baseSettings = JSON.parse(readFileSync(sharedSettings, 'utf8')) as Record<string, unknown>;
      } catch { /* ignore parse errors */ }
    }
    // Pre-set theme=dark so the theme picker is skipped on first run.
    if (!('theme' in baseSettings)) {
      baseSettings['theme'] = 'dark';
    }
    writeFileSync(sessionSettings, JSON.stringify(baseSettings), 'utf8');

    // Build env: inherit ambient vars but strip ANTHROPIC_API_KEY so claude
    // uses OAuth/Max-plan auth rather than API key auth.
    const spawnEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && k !== 'ANTHROPIC_API_KEY') {
        spawnEnv[k] = v;
      }
    }
    spawnEnv['HOME'] = home;

    // Spawn claude directly — no landlock needed for a temporary auth flow.
    const pty = spawn('claude', [], {
      name: 'xterm-256color',
      cols: 220,
      rows: 50,
      cwd,
      env: spawnEnv,
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
        // Claude is rendering — press Enter first (dismisses any first-run
        // prompt, e.g. theme picker), then send /login after the UI settles.
        if (!loginSent) {
          loginSent = true;
          // Step 1: dismiss any prompt (theme picker, etc.)
          setTimeout(() => {
            try { pty.write('\r'); } catch { /* may have exited */ }
          }, 600);
          // Step 2: send /login once the main REPL is ready
          setTimeout(() => {
            try {
              pty.write('/login\r');
              console.log(`[auth-pty] sent /login token=${token.slice(0, 8)}`);
            } catch { /* process may have exited */ }
          }, 1800);
        }
      }
      outputBuffer.push(data);
      outputStream.push(data);
    });

    // Fallback: if claude hasn't produced output in 5s, send /login anyway.
    setTimeout(() => {
      if (!loginSent) {
        loginSent = true;
        try {
          pty.write('\r');
        } catch { /* may have exited */ }
        setTimeout(() => {
          try {
            pty.write('/login\r');
            console.log(`[auth-pty] sent /login (fallback) token=${token.slice(0, 8)} bytesReceived=${bytesReceived}`);
          } catch { /* process may have exited */ }
        }, 1200);
      }
    }, 5000);

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
      homeDir: home,
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
      homeDir: entry.homeDir,
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
    // Clean up per-session dirs
    for (const dir of [`/tmp/orcha-auth-${token}`, entry.homeDir]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort
      }
    }
    this._sessions.delete(token);
  }
}
