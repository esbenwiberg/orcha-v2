import type { Task, InvestigationResult } from '../domain/task-types.js';
import type { TaskStore } from '../db/task-store.js';
import { buildInvestigationPrompt, INVESTIGATION_TOOLS } from './prompts.js';
import { extractJson } from './extract-json.js';
import { spawnClaude } from './spawn-claude.js';

export interface InvestigateContext {
  task: Task;
  taskStore: TaskStore;
  cwd: string;
  extraEnv?: Record<string, string>;
}

export async function investigate(ctx: InvestigateContext): Promise<InvestigationResult> {
  const { task, taskStore, cwd, extraEnv } = ctx;
  const prompt = buildInvestigationPrompt(task);

  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--allowedTools', INVESTIGATION_TOOLS,
    '--max-turns', '25',
    '--verbose',
    prompt,
  ];

  const { exitCode, resultText, eventCount, timedOut, stderrTail } = await spawnClaude({
    args,
    cwd,
    taskId: task.id,
    displayId: task.displayId,
    phase: 'investigate',
    taskStore,
    timeoutMs: 8 * 60_000, // 8 minutes
    ...(extraEnv !== undefined ? { extraEnv } : {}),
  });

  if (timedOut) {
    throw new Error('Investigation timed out after 8 minutes');
  }

  if (exitCode !== 0) {
    const hint = resultText ? `\nResult: ${resultText.slice(0, 300)}` : '';
    const stderr = stderrTail ? `\nStderr: ${stderrTail.slice(0, 300)}` : '';
    throw new Error(`Investigation failed (exit ${exitCode})${hint}${stderr}`);
  }

  if (eventCount === 0) {
    console.warn('[investigate] TASK-%d no stream-json events captured — claude may have failed silently', task.displayId);
  }

  const result = parseInvestigationResult(resultText);
  taskStore.setInvestigation(task.id, result);

  return result;
}

function parseInvestigationResult(text: string): InvestigationResult {
  if (!text.trim()) {
    console.warn('[investigate] investigation result text is empty — Claude may have hit the turn limit without producing a final response');
    return {
      rating: 'weak',
      summary: 'Investigation produced no output (likely hit the turn limit).',
      reasoning: '',
      pros: [],
      cons: ['Investigation output was empty — Claude may have exhausted max turns during tool use'],
      filesExamined: [],
    };
  }

  const parsed = extractJson(text);
  if (!parsed) {
    console.warn('[investigate] failed to parse investigation JSON, full text (%d chars):\n%s', text.length, text.slice(0, 1000));
    return {
      rating: 'weak',
      summary: 'Failed to parse structured investigation result.',
      reasoning: text.slice(0, 2000),
      pros: [],
      cons: ['Investigation output was not valid JSON'],
      filesExamined: [],
    };
  }

  return {
    rating: (parsed['rating'] as InvestigationResult['rating']) ?? 'weak',
    summary: (parsed['summary'] as string) ?? '',
    reasoning: (parsed['reasoning'] as string) ?? '',
    pros: (parsed['pros'] as string[]) ?? [],
    cons: (parsed['cons'] as string[]) ?? [],
    filesExamined: (parsed['filesExamined'] as string[]) ?? [],
    ...(parsed['webResearch'] !== undefined ? { webResearch: parsed['webResearch'] as string } : {}),
  };
}
