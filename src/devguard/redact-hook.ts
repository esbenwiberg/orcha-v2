import { createInterface } from 'node:readline';

// Patterns that look like secrets
// [pattern, replacement, id (for disabling via config)]
export const SECRET_PATTERNS: Array<[RegExp, string, string]> = [
  // GitHub fine-grained PATs
  [/github_pat_[A-Za-z0-9_]{82}/g, '[REDACTED-GH-PAT]', 'github-pat-fine'],
  // GitHub classic PATs
  [/ghp_[A-Za-z0-9]{36}/g, '[REDACTED-GH-PAT]', 'github-pat-classic'],
  // Azure DevOps PATs (52-char base64, must appear before generic 40+ pattern)
  [/(?<![A-Za-z0-9])[A-Za-z0-9]{52}(?![A-Za-z0-9])/g, '[REDACTED]', 'devops-pat'],
  // Generic high-entropy tokens (40+ base64/hex chars after = or :)
  [/(?<=[=:])([A-Za-z0-9+/]{40,}={0,2})/g, '[REDACTED]', 'generic-token'],
  // Env-var assignments where value looks secret
  [/((?:SECRET|TOKEN|PAT|PASSWORD|KEY|CREDENTIAL)s?\s*=\s*)\S+/gi, '$1[REDACTED]', 'env-assignment'],
  // UUID pattern (can be aggressive — subscription IDs etc.)
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[REDACTED-UUID]', 'uuid'],
];

export function redact(
  text: string,
  disabledPatternIds: Set<string> = new Set(),
  extraPatterns: Array<[RegExp, string]> = [],
): string {
  let out = text;

  for (const [pattern, replacement, id] of SECRET_PATTERNS) {
    if (!disabledPatternIds.has(id)) {
      out = out.replace(pattern, replacement);
    }
  }

  for (const [pattern, replacement] of extraPatterns) {
    out = out.replace(pattern, replacement);
  }

  return out;
}

async function main() {
  const chunks: string[] = [];
  for await (const line of createInterface({ input: process.stdin })) {
    chunks.push(line);
  }
  const raw = chunks.join('\n');

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Not JSON — pass through unchanged (fail-open)
    process.stdout.write(raw);
    process.exit(0);
  }

  const p = payload as Record<string, unknown>;
  const toolResponse = p['tool_response'] as Record<string, unknown> | undefined;

  if (toolResponse) {
    if (typeof toolResponse['output'] === 'string') {
      toolResponse['output'] = redact(toolResponse['output']);
    }
    if (typeof toolResponse['error'] === 'string') {
      toolResponse['error'] = redact(toolResponse['error']);
    }
  }

  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}

main().catch(() => {
  // Fail-open: if hook errors, just pass through
  process.exit(1);
});
