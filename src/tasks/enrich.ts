import type { Task, EnrichmentResult } from '../domain/task-types.js';
import type { TaskStore } from '../db/task-store.js';
import { buildEnrichmentPrompt, ENRICHMENT_TOOLS } from './prompts.js';
import { spawnClaude } from './spawn-claude.js';

export interface EnrichContext {
  task: Task;
  taskStore: TaskStore;
  cwd: string;
  extraEnv?: Record<string, string>;
}

export async function enrich(ctx: EnrichContext): Promise<EnrichmentResult> {
  const { task, taskStore, cwd, extraEnv } = ctx;
  const prompt = buildEnrichmentPrompt(task);

  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--allowedTools', ENRICHMENT_TOOLS,
    '--max-turns', '20',
    '--verbose',
    prompt,
  ];

  const { exitCode, resultText, eventCount, timedOut } = await spawnClaude({
    args,
    cwd,
    taskId: task.id,
    displayId: task.displayId,
    phase: 'enrich',
    taskStore,
    timeoutMs: 5 * 60_000, // 5 minutes
    ...(extraEnv !== undefined ? { extraEnv } : {}),
  });

  if (timedOut) {
    throw new Error('Enrichment timed out after 5 minutes');
  }

  if (exitCode !== 0) {
    throw new Error(`Enrichment failed (exit ${exitCode})`);
  }

  if (eventCount === 0) {
    console.warn('[enrich] TASK-%d no stream-json events captured — claude may have failed silently', task.displayId);
  }

  const result = parseEnrichmentResult(resultText);
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
