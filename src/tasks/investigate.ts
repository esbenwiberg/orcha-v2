import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Task, InvestigationResult } from '../domain/task-types.js';
import type { TaskStore } from '../db/task-store.js';
import { buildInvestigationPrompt, INVESTIGATION_TOOLS } from './prompts.js';
import { eventBus } from '../web/services/event-bus.js';

export interface InvestigateContext {
  task: Task;
  taskStore: TaskStore;
  cwd: string;
}

export async function investigate(ctx: InvestigateContext): Promise<InvestigationResult> {
  const { task, taskStore, cwd } = ctx;
  const prompt = buildInvestigationPrompt(task);

  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--allowedTools', INVESTIGATION_TOOLS,
    '--max-turns', '15',
    '--verbose',
    prompt,
  ];

  const proc = spawn('claude', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  let seq = 0;
  let lastResultText = '';

  const rl = createInterface({ input: proc.stdout! });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const eventType = (event['type'] as string) ?? 'unknown';

      taskStore.appendTranscript(task.id, 'investigate', seq++, eventType, event);
      eventBus.publish({
        type: 'task-transcript',
        taskId: task.id,
        phase: 'investigate',
        seq: seq - 1,
        event,
      });

      // Capture the final result text
      if (eventType === 'result') {
        const result = event['result'] as Record<string, unknown> | undefined;
        if (result) {
          lastResultText = (result['text'] as string) ?? '';
        }
      }
    } catch {
      // Non-JSON line — ignore
    }
  });

  // Collect stderr for error reporting
  let stderr = '';
  proc.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const exitCode = await new Promise<number>((resolve) => {
    proc.on('close', (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    throw new Error(`Investigation failed (exit ${exitCode}): ${stderr.slice(0, 500)}`);
  }

  // Parse the investigation result from the final result text
  const result = parseInvestigationResult(lastResultText);
  taskStore.setInvestigation(task.id, result);

  return result;
}

function parseInvestigationResult(text: string): InvestigationResult {
  // Try to extract JSON from the text (may be wrapped in markdown fences)
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, text];
  const jsonStr = (jsonMatch[1] ?? text).trim();

  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    return {
      rating: (parsed['rating'] as InvestigationResult['rating']) ?? 'weak',
      summary: (parsed['summary'] as string) ?? '',
      reasoning: (parsed['reasoning'] as string) ?? '',
      pros: (parsed['pros'] as string[]) ?? [],
      cons: (parsed['cons'] as string[]) ?? [],
      filesExamined: (parsed['filesExamined'] as string[]) ?? [],
      ...(parsed['webResearch'] !== undefined ? { webResearch: parsed['webResearch'] as string } : {}),
    };
  } catch {
    // If we can't parse JSON, return a minimal result based on the raw text
    return {
      rating: 'weak',
      summary: 'Failed to parse structured investigation result.',
      reasoning: text.slice(0, 2000),
      pros: [],
      cons: ['Investigation output was not valid JSON'],
      filesExamined: [],
    };
  }
}
