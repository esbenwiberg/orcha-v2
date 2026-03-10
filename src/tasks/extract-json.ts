/**
 * Try multiple strategies to extract a JSON object from Claude's result text:
 * 1. Direct parse (clean JSON output)
 * 2. Markdown fenced code block extraction
 * 3. Find outermost { ... } braces
 *
 * Each strategy also retries after fixing trailing commas (common LLM quirk).
 */
export function extractJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();

  // Strategy 1: direct parse
  const direct = tryParseObject(trimmed);
  if (direct) return direct;

  // Strategy 2: extract from markdown fences
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch?.[1]) {
    const fenced = tryParseObject(fenceMatch[1].trim());
    if (fenced) return fenced;
  }

  // Strategy 3: find the outermost { ... }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const braced = tryParseObject(trimmed.slice(firstBrace, lastBrace + 1));
    if (braced) return braced;
  }

  return null;
}

/** Try JSON.parse, then retry after fixing common LLM JSON quirks (trailing commas). */
function tryParseObject(text: string): Record<string, unknown> | null {
  // Attempt 1: parse as-is
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj as Record<string, unknown>;
  } catch { /* continue */ }

  // Attempt 2: strip trailing commas before ] or }
  const cleaned = text.replace(/,\s*([}\]])/g, '$1');
  if (cleaned !== text) {
    try {
      const obj = JSON.parse(cleaned);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj as Record<string, unknown>;
    } catch { /* continue */ }
  }

  return null;
}
