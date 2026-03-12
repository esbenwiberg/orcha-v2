import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface CaptureResult {
  capturedAt: string;
  sizeBytes: number;
  messageCount: number;
}

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB per file cap

/**
 * Copies Claude JSONL history files from a per-session HOME to durable storage.
 * Returns capture metadata, or null if no history files were found.
 *
 * Uses readFileSync/writeFileSync only (Azure Files safe — no chmod, no copyFileSync).
 */
export function captureSessionHistory(
  sessionId: string,
  homeDir: string,
  dataDir: string,
): CaptureResult | null {
  const projectsDir = join(homeDir, '.claude', 'projects');
  if (!existsSync(projectsDir)) return null;

  // Scan all subdirs under .claude/projects/ for .jsonl files
  const jsonlFiles: { relPath: string; absPath: string }[] = [];
  try {
    for (const subdir of readdirSync(projectsDir)) {
      const subdirPath = join(projectsDir, subdir);
      try {
        const stat = statSync(subdirPath);
        if (!stat.isDirectory()) continue;
      } catch {
        continue;
      }

      try {
        for (const file of readdirSync(subdirPath)) {
          if (file.endsWith('.jsonl')) {
            jsonlFiles.push({
              relPath: join(subdir, file),
              absPath: join(subdirPath, file),
            });
          }
        }
      } catch {
        // Can't read subdir — skip
      }
    }
  } catch {
    return null;
  }

  if (jsonlFiles.length === 0) return null;

  const destDir = join(dataDir, 'session-history', sessionId);
  mkdirSync(destDir, { recursive: true });

  let totalBytes = 0;
  let totalLines = 0;

  for (const { relPath, absPath } of jsonlFiles) {
    try {
      const stat = statSync(absPath);
      if (stat.size > MAX_FILE_BYTES) {
        console.warn(`[history] skipping oversized file (${stat.size} bytes): ${absPath}`);
        continue;
      }

      const content = readFileSync(absPath);
      const destPath = join(destDir, relPath);
      mkdirSync(join(destDir, relPath, '..'), { recursive: true });
      writeFileSync(destPath, content);

      totalBytes += content.byteLength;
      // Count newlines for message count (each JSONL line = one message)
      for (let i = 0; i < content.byteLength; i++) {
        if (content[i] === 0x0a) totalLines++;
      }
    } catch (err) {
      console.warn(`[history] failed to copy ${absPath}:`, err);
    }
  }

  if (totalBytes === 0) return null;

  return {
    capturedAt: new Date().toISOString(),
    sizeBytes: totalBytes,
    messageCount: totalLines,
  };
}
