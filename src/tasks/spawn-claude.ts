import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { eventBus } from '../web/services/event-bus.js';
import type { TaskStore } from '../db/task-store.js';

export interface SpawnClaudeOptions {
  args: string[];
  cwd: string;
  taskId: string;
  displayId: number;
  phase: string;
  taskStore: TaskStore;
  /** Kill the process after this many ms. Default: 5 minutes. */
  timeoutMs?: number;
}

export interface SpawnClaudeResult {
  exitCode: number;
  resultText: string;
  eventCount: number;
  timedOut: boolean;
}

/**
 * Spawn `claude --print --output-format stream-json --verbose ...` and stream
 * transcript events back to the DB + SSE bus.
 *
 * With `--verbose`, stream-json events are emitted on **stderr** (not stdout).
 * We read stderr line-by-line, parse JSON events, and ignore non-JSON lines.
 */
export function spawnClaude(opts: SpawnClaudeOptions): Promise<SpawnClaudeResult> {
  const { args, cwd, taskId, displayId, phase, taskStore, timeoutMs = 5 * 60_000 } = opts;

  // Strip CLAUDECODE to avoid "nested session" rejection, and
  // ensure clean env for the child process.
  const env = { ...process.env };
  delete env['CLAUDECODE'];

  const proc = spawn('claude', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });

  let seq = 0;
  let lastResultText = '';
  let timedOut = false;

  // With --verbose, stream-json events go to stderr.
  const rl = createInterface({ input: proc.stderr! });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const eventType = (event['type'] as string) ?? 'unknown';

      taskStore.appendTranscript(taskId, phase, seq++, eventType, event);
      eventBus.publish({
        type: 'task-transcript',
        taskId,
        phase,
        seq: seq - 1,
        event,
      });

      // Capture the final result text
      if (eventType === 'result') {
        const raw = event['result'];
        if (typeof raw === 'string') {
          lastResultText = raw;
        } else if (raw && typeof raw === 'object') {
          lastResultText = ((raw as Record<string, unknown>)['text'] as string) ?? '';
        }
      }
    } catch {
      // Non-JSON line — ignore (could be verbose diagnostic output)
    }
  });

  // Also collect stdout (may have output in some CLI versions)
  let stdout = '';
  proc.stdout!.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  // Timeout guard — kill the process if it runs too long
  const timer = setTimeout(() => {
    timedOut = true;
    console.warn('[spawn-claude] TASK-%d %s timed out after %dms — killing', displayId, phase, timeoutMs);
    proc.kill('SIGTERM');
    // Force-kill after 5s if SIGTERM didn't work
    setTimeout(() => {
      if (!proc.killed) proc.kill('SIGKILL');
    }, 5_000);
  }, timeoutMs);

  return new Promise<SpawnClaudeResult>((resolve) => {
    proc.on('close', (code) => {
      clearTimeout(timer);
      rl.close();

      const exitCode = code ?? 1;

      console.log('[spawn-claude] TASK-%d %s exited: code=%d events=%d resultLen=%d timedOut=%s',
        displayId, phase, exitCode, seq, lastResultText.length, timedOut);

      if (stdout.length > 0) {
        console.log('[spawn-claude] TASK-%d %s stdout: %s', displayId, phase, stdout.slice(0, 500));
      }

      // If we got the result from the stream-json 'result' event, use it.
      // Otherwise fall back to stdout (some CLI versions may output there).
      const resultText = lastResultText || stdout.trim();

      resolve({ exitCode, resultText, eventCount: seq, timedOut });
    });
  });
}
