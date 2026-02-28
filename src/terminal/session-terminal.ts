export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface SessionTerminal {
  readonly sessionId: string;
  readonly pid: number | undefined;
  readonly exitCode: number | undefined;
  write(data: string): void;
  resize(size: TerminalSize): void;
  kill(signal?: string): void;
  readonly output: NodeJS.ReadableStream;
  on(event: 'exit', listener: (code: number, signal: string) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

export type PtySpawnOptions = {
  sessionId: string;
  cwd: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  size?: TerminalSize;
  /** Per-session sandbox override. Defaults to true (isolated). Only takes effect when SANDBOX_MODE=bwrap. */
  sandbox?: boolean;
};
