import type { Task, InvestigationResult } from '../domain/task-types.js';
import type { TaskStore } from '../db/task-store.js';
import { buildInvestigationPrompt, INVESTIGATION_TOOLS } from './prompts.js';
import { spawnClaude } from './spawn-claude.js';

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

  const { exitCode, resultText, eventCount, timedOut } = await spawnClaude({
    args,
    cwd,
    taskId: task.id,
    displayId: task.displayId,
    phase: 'investigate',
    taskStore,
    timeoutMs: 5 * 60_000, // 5 minutes
  });

  if (timedOut) {
    throw new Error('Investigation timed out after 5 minutes');
  }

  if (exitCode !== 0) {
    throw new Error(`Investigation failed (exit ${exitCode})`);
  }

  if (eventCount === 0) {
    console.warn('[investigate] TASK-%d no stream-json events captured — claude may have failed silently', task.displayId);
  }

  const result = parseInvestigationResult(resultText);
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
