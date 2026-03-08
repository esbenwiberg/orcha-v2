import type { Task, InvestigationResult } from '../domain/task-types.js';
import type { TaskStore } from '../db/task-store.js';
import { buildInvestigationPrompt, INVESTIGATION_TOOLS } from './prompts.js';
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
    '--max-turns', '15',
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
    timeoutMs: 5 * 60_000, // 5 minutes
    ...(extraEnv !== undefined ? { extraEnv } : {}),
  });

  if (timedOut) {
    throw new Error('Investigation timed out after 5 minutes');
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
  const parsed = extractJson(text);
  if (!parsed) {
    console.warn('[investigate] failed to parse investigation JSON, text starts with: %s', text.slice(0, 200));
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

/**
 * Try multiple strategies to extract a JSON object from Claude's result text:
 * 1. Direct parse (clean JSON output)
 * 2. Markdown fenced code block extraction
 * 3. Find outermost { ... } braces
 */
function extractJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();

  // Strategy 1: direct parse
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj as Record<string, unknown>;
  } catch { /* continue */ }

  // Strategy 2: extract from markdown fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch?.[1]) {
    try {
      const obj = JSON.parse(fenceMatch[1].trim());
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj as Record<string, unknown>;
    } catch { /* continue */ }
  }

  // Strategy 3: find the outermost { ... }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const obj = JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj as Record<string, unknown>;
    } catch { /* continue */ }
  }

  return null;
}
