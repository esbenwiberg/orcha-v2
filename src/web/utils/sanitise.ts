import path from 'node:path';
import { AppError } from '../errors.js';

/**
 * Validates that a shell argument contains only safe characters.
 * Throws AppError(400) if the value contains any character outside [a-zA-Z0-9._/@:-].
 */
export function sanitiseShellArg(value: string): string {
  const trimmed = value.trim();
  if (!/^[a-zA-Z0-9._/@:-]+$/.test(trimmed)) {
    throw new AppError(400, 'Invalid argument', 'INVALID_INPUT');
  }
  return trimmed;
}

/**
 * Validates a git branch name.
 * In addition to sanitiseShellArg checks, rejects values containing `..`,
 * starting with `-`, or containing whitespace.
 */
export function sanitiseBranchName(value: string): string {
  const trimmed = value.trim();
  if (
    !/^[a-zA-Z0-9._/@:-]+$/.test(trimmed) ||
    trimmed.includes('..') ||
    trimmed.startsWith('-') ||
    /\s/.test(trimmed)
  ) {
    throw new AppError(400, 'Invalid argument', 'INVALID_INPUT');
  }
  return trimmed;
}

/**
 * Resolves a path and validates it is absolute.
 * Throws AppError(400) if the resolved path does not start with `/`.
 */
export function sanitisePath(value: string): string {
  const resolved = path.resolve(value);
  if (!resolved.startsWith('/')) {
    throw new AppError(400, 'Invalid argument', 'INVALID_INPUT');
  }
  return resolved;
}
