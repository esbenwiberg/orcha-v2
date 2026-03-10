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
  // Split into lines so we can rejoin wrapped URLs.
  // When a URL is wider than the PTY, the terminal wraps it: the URL continues
  // on the next line with no leading whitespace. We detect this by checking
  // that the continuation line has no spaces (real sentences have spaces).
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const httpIdx = line.indexOf('https://');
    if (httpIdx === -1) continue;

    // Start URL from where https:// appears on this line.
    let url = line.slice(httpIdx).trimEnd();

    // Append continuation lines caused by terminal line-wrapping.
    for (let j = i + 1; j < Math.min(i + 20, lines.length); j++) {
      const next = (lines[j] ?? '').trimEnd();
      if (next.length === 0) break;             // blank line = real end
      if (/^\s/.test(next)) break;              // leading space = new paragraph
      if (next.includes(' ')) break;            // spaces = regular sentence, not URL
      if (!/^[A-Za-z0-9%&=+_.,:/?@#!$'()*~-]/.test(next)) break;
      url += next;
    }

    // Trim any trailing punctuation that might have been captured.
    url = url.replace(/[.,;:)"']+$/, '');

    // Require a minimum meaningful URL length (filters noise).
    if (url.length > 40) return url;
  }

  return undefined;
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

    // Write .config.json to suppress all first-run prompts (onboarding, theme
    // picker, project trust dialog) so the auth terminal can proceed straight
    // to /login without needing carriage-return hacks to dismiss them.
    const claudeConfig: Record<string, unknown> = {
      hasCompletedOnboarding: true,
      theme: 'dark',
      projects: {
        [cwd]: {
          hasTrustDialogAccepted: true,
          allowedTools: [],
        },
      },
    };
    writeFileSync(join(claudeDir, '.config.json'), JSON.stringify(claudeConfig), 'utf8');

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
    // Use a wide terminal (500 cols) to prevent URL line-wrapping, which would
    // cause the OAuth state parameter to be cut off when we extract the URL.
    const pty = spawn('claude', [], {
      name: 'xterm-256color',
      cols: 500,
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
        // .config.json suppresses onboarding/theme/trust prompts, so we can
        // send /login directly once the REPL is ready (no dismiss-enter needed).
        if (!loginSent) {
          loginSent = true;
          setTimeout(() => {
            try {
              pty.write('/login\r');
              console.log(`[auth-pty] sent /login token=${token.slice(0, 8)}`);
            } catch { /* process may have exited */ }
          }, 1200);
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
          pty.write('/login\r');
          console.log(`[auth-pty] sent /login (fallback) token=${token.slice(0, 8)} bytesReceived=${bytesReceived}`);
        } catch { /* process may have exited */ }
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
