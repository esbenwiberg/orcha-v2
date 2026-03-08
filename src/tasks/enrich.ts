import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Task, EnrichmentResult } from '../domain/task-types.js';
import type { TaskStore } from '../db/task-store.js';
import { buildEnrichmentPrompt, ENRICHMENT_TOOLS } from './prompts.js';
import { eventBus } from '../web/services/event-bus.js';

export interface EnrichContext {
  task: Task;
  taskStore: TaskStore;
  cwd: string;
}

export async function enrich(ctx: EnrichContext): Promise<EnrichmentResult> {
  const { task, taskStore, cwd } = ctx;
  const prompt = buildEnrichmentPrompt(task);

  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--allowedTools', ENRICHMENT_TOOLS,
    '--max-turns', '20',
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

      taskStore.appendTranscript(task.id, 'enrich', seq++, eventType, event);
      eventBus.publish({
        type: 'task-transcript',
        taskId: task.id,
        phase: 'enrich',
        seq: seq - 1,
        event,
      });

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

  let stderr = '';
  proc.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const exitCode = await new Promise<number>((resolve) => {
    proc.on('close', (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    throw new Error(`Enrichment failed (exit ${exitCode}): ${stderr.slice(0, 500)}`);
  }

  const result = parseEnrichmentResult(lastResultText);
  taskStore.setEnrichment(task.id, result);

  return result;
}

function parseEnrichmentResult(text: string): EnrichmentResult {
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, text];
  const jsonStr = (jsonMatch[1] ?? text).trim();

  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    return {
      improvedDescription: (parsed['improvedDescription'] as string) ?? '',
      affectedFiles: (parsed['affectedFiles'] as EnrichmentResult['affectedFiles']) ?? [],
      approach: (parsed['approach'] as EnrichmentResult['approach']) ?? [],
      risks: (parsed['risks'] as EnrichmentResult['risks']) ?? [],
      complexity: (parsed['complexity'] as EnrichmentResult['complexity']) ?? 'medium',
      acceptanceCriteria: (parsed['acceptanceCriteria'] as string[]) ?? [],
      relatedCode: (parsed['relatedCode'] as EnrichmentResult['relatedCode']) ?? [],
    };
  } catch {
    return {
      improvedDescription: text.slice(0, 2000),
      affectedFiles: [],
      approach: [],
      risks: [{ description: 'Enrichment output was not valid JSON', severity: 'medium', mitigation: 'Review manually' }],
      complexity: 'medium',
      acceptanceCriteria: [],
      relatedCode: [],
    };
  }
}
