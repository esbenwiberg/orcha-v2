import { spawn } from 'node:child_process';
import { AppError } from '../errors.js';
import { sanitiseShellArg } from './sanitise.js';

export interface GitResult {
  stdout: string;
  stderr: string;
}

/**
 * Spawns git with the given args in the given cwd.
 * Each arg is validated with sanitiseShellArg before spawning.
 * Rejects with AppError(500, stderr, 'GIT_ERROR') on non-zero exit.
 * GIT_TERMINAL_PROMPT=0 prevents git from hanging waiting for credentials.
 */
export async function executeGit(args: string[], cwd: string): Promise<GitResult> {
  // Validate every arg before passing to spawn
  for (const arg of args) {
    sanitiseShellArg(arg);
  }

  return new Promise<GitResult>((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');

      if (code !== 0) {
        reject(new AppError(500, stderr, 'GIT_ERROR'));
        return;
      }

      resolve({ stdout, stderr });
    });

    child.on('error', (err) => {
      reject(new AppError(500, String(err), 'GIT_ERROR'));
    });
  });
}
