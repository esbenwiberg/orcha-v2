import { EventEmitter } from 'node:events';
import { CLAUDE_PATTERNS } from './claude-patterns.js';
import type { SessionTerminal } from './session-terminal.js';

export type SessionStatus =
  | 'running'
  | 'idle'
  | 'thinking'
  | 'tool-use'
  | 'needs-input'
  | 'complete'
  | 'error';

export type StatusEvent =
  | { type: 'status-change'; sessionId: string; status: SessionStatus; prevStatus: SessionStatus; timestamp: Date }
  | { type: 'needs-input'; sessionId: string; prompt: string; timestamp: Date };

interface SessionEntry {
  status: SessionStatus;
  lastOutputAt: number;
  idleTimer: NodeJS.Timeout | undefined;
}

export class StatusMonitor extends EventEmitter {
  private _idleTimeoutMs: number;
  private _sessions: Map<string, SessionEntry> = new Map();

  constructor(idleTimeoutMs: number = 10_000) {
    super();
    this._idleTimeoutMs = idleTimeoutMs;
  }

  watch(sessionId: string, terminal: SessionTerminal): void {
    if (this._sessions.has(sessionId)) {
      return;
    }

    const entry: SessionEntry = {
      status: 'running',
      lastOutputAt: Date.now(),
      idleTimer: undefined,
    };
    this._sessions.set(sessionId, entry);

    terminal.output.on('data', (chunk: Buffer | string) => {
      this._processChunk(sessionId, chunk.toString('utf8'));
    });

    terminal.on('exit', (exitCode: number) => {
      this._setStatus(sessionId, exitCode === 0 ? 'complete' : 'error');
      this.unwatch(sessionId);
    });
  }

  unwatch(sessionId: string): void {
    const entry = this._sessions.get(sessionId);
    if (entry === undefined) {
      return;
    }
    if (entry.idleTimer !== undefined) {
      clearTimeout(entry.idleTimer);
    }
    this._sessions.delete(sessionId);
  }

  private _processChunk(sessionId: string, text: string): void {
    const entry = this._sessions.get(sessionId);
    if (entry === undefined) {
      return;
    }

    entry.lastOutputAt = Date.now();

    if (entry.idleTimer !== undefined) {
      clearTimeout(entry.idleTimer);
    }
    entry.idleTimer = setTimeout(() => {
      this._setStatus(sessionId, 'idle');
    }, this._idleTimeoutMs);

    if (CLAUDE_PATTERNS.NEEDS_CONFIRMATION.test(text) || CLAUDE_PATTERNS.NEEDS_PERMISSION.test(text)) {
      this._setStatus(sessionId, 'needs-input');
      const needsInputEvent: StatusEvent & { type: 'needs-input' } = {
        type: 'needs-input',
        sessionId,
        prompt: text.slice(0, 200),
        timestamp: new Date(),
      };
      this.emit('needs-input', needsInputEvent);
    } else if (CLAUDE_PATTERNS.ERROR_FATAL.test(text)) {
      this._setStatus(sessionId, 'error');
    } else if (CLAUDE_PATTERNS.TASK_COMPLETE.test(text)) {
      this._setStatus(sessionId, 'complete');
    } else if (CLAUDE_PATTERNS.TOOL_USE.test(text)) {
      this._setStatus(sessionId, 'tool-use');
    } else if (CLAUDE_PATTERNS.THINKING.test(text)) {
      this._setStatus(sessionId, 'thinking');
    }
  }

  private _setStatus(sessionId: string, next: SessionStatus): void {
    const entry = this._sessions.get(sessionId);
    if (entry === undefined) {
      return;
    }
    if (next === entry.status) {
      return;
    }
    const prev = entry.status;
    entry.status = next;
    const statusChangeEvent: StatusEvent & { type: 'status-change' } = {
      type: 'status-change',
      sessionId,
      status: next,
      prevStatus: prev,
      timestamp: new Date(),
    };
    this.emit('status-change', statusChangeEvent);
  }

  getStatus(sessionId: string): SessionStatus | undefined {
    return this._sessions.get(sessionId)?.status;
  }

  on(event: 'status-change', listener: (e: StatusEvent & { type: 'status-change' }) => void): this;
  on(event: 'needs-input', listener: (e: StatusEvent & { type: 'needs-input' }) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }
}
