import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { redact } from './redact-hook.js';

export interface ScrubResult {
  filesScanned: number;
  redactionsApplied: number;
}

/** Encode a project path to the Claude project directory name */
function encodeProjectPath(projectPath: string): string {
  // Claude encodes the absolute path by replacing / with - and prepending -
  // e.g. /home/user/myproject → -home-user-myproject
  return projectPath.replace(/\//g, '-');
}

/** Recursively redact all string values in an object */
function redactObject(obj: unknown): [unknown, number] {
  if (typeof obj === 'string') {
    const redacted = redact(obj);
    return [redacted, redacted !== obj ? 1 : 0];
  }
  if (Array.isArray(obj)) {
    let count = 0;
    const result = obj.map((item) => {
      const [r, c] = redactObject(item);
      count += c;
      return r;
    });
    return [result, count];
  }
  if (obj !== null && typeof obj === 'object') {
    let count = 0;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const [r, c] = redactObject(value);
      result[key] = r;
      count += c;
    }
    return [result, count];
  }
  return [obj, 0];
}

export async function scrubHistory(projectPath: string): Promise<ScrubResult> {
  const absPath = path.resolve(projectPath);
  const encoded = encodeProjectPath(absPath);
  const claudeProjectDir = path.join(os.homedir(), '.claude', 'projects', encoded);

  if (!fs.existsSync(claudeProjectDir)) {
    console.log(`Claude project directory not found: ${claudeProjectDir}`);
    return { filesScanned: 0, redactionsApplied: 0 };
  }

  const files = fs
    .readdirSync(claudeProjectDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(claudeProjectDir, f));

  let totalRedactions = 0;

  for (const filePath of files) {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    let fileRedactions = 0;
    const newLines: string[] = [];

    for (const line of lines) {
      if (!line.trim()) {
        newLines.push(line);
        continue;
      }
      try {
        const parsed = JSON.parse(line) as unknown;
        const [redacted, count] = redactObject(parsed);
        fileRedactions += count;
        newLines.push(JSON.stringify(redacted));
      } catch {
        // Malformed line — pass through
        newLines.push(line);
      }
    }

    if (fileRedactions > 0) {
      // Write atomically
      const tmpPath = filePath + '.tmp';
      fs.writeFileSync(tmpPath, newLines.join('\n'), 'utf8');
      fs.renameSync(tmpPath, filePath);
      totalRedactions += fileRedactions;
    }
  }

  return { filesScanned: files.length, redactionsApplied: totalRedactions };
}
