import type { Task, InvestigationResult, InvestigationRating } from '../domain/task-types.js';
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
    // Salvage a rating from the prose if possible
    const rating = inferRatingFromProse(text);
    return {
      rating,
      summary: `Investigation completed but output was not structured JSON (inferred rating: ${rating}).`,
      reasoning: text.slice(0, 2000),
      pros: [],
      cons: ['Investigation output was not valid JSON — rating inferred from prose'],
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

const RATING_KEYWORDS: [RegExp, InvestigationRating][] = [
  [/\bexcellent\b/i, 'excellent'],
  [/\breject\b/i, 'reject'],
  [/\bstraightforward\b/i, 'good'],
  [/\bgood\b/i, 'good'],
  [/\bviable\b/i, 'viable'],
  [/\bweak\b/i, 'weak'],
];

/** Best-effort rating inference from prose text when JSON parsing fails. */
function inferRatingFromProse(text: string): InvestigationRating {
  const lower = text.toLowerCase();
  // Check for explicit rating mentions first (e.g. 'rating: "excellent"' or 'Rating: excellent')
  const explicit = lower.match(/rating[:\s]*["']?(reject|weak|viable|good|excellent)["']?/);
  if (explicit) return explicit[1] as InvestigationRating;

  // Fall back to keyword scanning
  for (const [re, rating] of RATING_KEYWORDS) {
    if (re.test(lower)) return rating;
  }
  return 'viable'; // default to viable — Claude did produce analysis, just not JSON
}
