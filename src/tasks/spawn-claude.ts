import { spawn } from 'node:child_process';
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
  /** Extra env vars to merge (e.g. ANTHROPIC_API_KEY from model config). */
  extraEnv?: Record<string, string>;
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
 * Stream-json events may arrive on stdout OR stderr depending on the
 * environment (CLAUDECODE env var, CLI version). We parse JSON lines from
 * BOTH streams to handle all cases.
 */
export function spawnClaude(opts: SpawnClaudeOptions): Promise<SpawnClaudeResult> {
  const { args, cwd, taskId, displayId, phase, taskStore, timeoutMs = 5 * 60_000, extraEnv } = opts;

  // Strip CLAUDECODE to avoid "nested session" rejection.
  // Merge extraEnv (model config vars like ANTHROPIC_API_KEY) on top.
  const env = { ...process.env, ...extraEnv };
  delete env['CLAUDECODE'];

  const proc = spawn('claude', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });

  let seq = 0;
  let lastResultText = '';
  let timedOut = false;

  /** Parse a line from either stream — JSON events get recorded, non-JSON ignored. */
  const handleLine = (line: string) => {
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
      // Non-JSON line — ignore (verbose diagnostic output, etc.)
    }
  };

  // Read JSON events from BOTH stdout and stderr.
  const rlOut = createInterface({ input: proc.stdout! });
  const rlErr = createInterface({ input: proc.stderr! });
  rlOut.on('line', handleLine);
  rlErr.on('line', handleLine);

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

  return new Promise<SpawnClaudeResult>((resolve, reject) => {
    // Handle spawn failures (ENOENT if claude not found or cwd doesn't exist)
    proc.on('error', (err) => {
      clearTimeout(timer);
      rlOut.close();
      rlErr.close();
      console.error('[spawn-claude] TASK-%d %s spawn error: %s', displayId, phase, err.message);
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      rlOut.close();
      rlErr.close();

      const exitCode = code ?? 1;

      console.log('[spawn-claude] TASK-%d %s exited: code=%d events=%d resultLen=%d timedOut=%s',
        displayId, phase, exitCode, seq, lastResultText.length, timedOut);

      resolve({ exitCode, resultText: lastResultText, eventCount: seq, timedOut });
    });
  });
}
