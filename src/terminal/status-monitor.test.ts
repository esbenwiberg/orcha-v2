import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StatusMonitor } from './status-monitor.js';
import type { SessionTerminal } from './session-terminal.js';

// Mock terminal that satisfies SessionTerminal interface
class MockOutput extends EventEmitter {}

class MockTerminal extends EventEmitter implements SessionTerminal {
  readonly sessionId: string;
  readonly pid: number | undefined = 1234;
  readonly exitCode: number | undefined = undefined;
  readonly output: MockOutput;

  constructor(sessionId: string) {
    super();
    this.sessionId = sessionId;
    this.output = new MockOutput();
  }

  write(): void {}
  resize(): void {}
  kill(): void {}
}

describe('StatusMonitor', () => {
  let monitor: StatusMonitor;
  let terminal: MockTerminal;
  const SESSION_ID = 'test-session-1';

  beforeEach(() => {
    vi.useFakeTimers();
    monitor = new StatusMonitor(100);
    terminal = new MockTerminal(SESSION_ID);
    monitor.watch(SESSION_ID, terminal);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('(a) TOOL_USE chunk emits status-change with status tool-use', () => {
    const events: Array<{ status: string }> = [];
    monitor.on('status-change', (e) => events.push(e));

    terminal.output.emit('data', Buffer.from('● SomeToolName'));

    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('tool-use');
  });

  it('(b) NEEDS_CONFIRMATION chunk emits both status-change and needs-input events', () => {
    const statusChanges: Array<{ status: string }> = [];
    const needsInputEvents: Array<{ prompt: string }> = [];

    monitor.on('status-change', (e) => statusChanges.push(e));
    monitor.on('needs-input', (e) => needsInputEvents.push(e));

    terminal.output.emit('data', Buffer.from('Continue? [y/n]'));

    expect(statusChanges).toHaveLength(1);
    expect(statusChanges[0].status).toBe('needs-input');

    expect(needsInputEvents).toHaveLength(1);
    expect(needsInputEvents[0]).toHaveProperty('prompt');
    expect(typeof needsInputEvents[0].prompt).toBe('string');
  });

  it('(c) after 100ms with no output, status-change fires with status idle', () => {
    const events: Array<{ status: string }> = [];
    monitor.on('status-change', (e) => events.push(e));

    // Emit something first to set up the idle timer
    terminal.output.emit('data', Buffer.from('some output'));

    // Clear any status-change from the chunk (none expected since it doesn't match patterns)
    events.length = 0;

    vi.advanceTimersByTime(100);

    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('idle');
  });

  it('(d) timer resets on new output — idle does not fire until 100ms after last output', () => {
    const events: Array<{ status: string }> = [];
    monitor.on('status-change', (e) => {
      if (e.status === 'idle') events.push(e);
    });

    // Emit output at t=0
    terminal.output.emit('data', Buffer.from('first output'));

    // Advance 80ms — no idle yet
    vi.advanceTimersByTime(80);
    expect(events).toHaveLength(0);

    // Emit output at t=80ms — resets the timer
    terminal.output.emit('data', Buffer.from('second output'));

    // Advance another 80ms (total 160ms since first output, but only 80ms since last output)
    vi.advanceTimersByTime(80);
    expect(events).toHaveLength(0);

    // Advance 100ms more from last output (20 + 80 = 100ms since second output)
    vi.advanceTimersByTime(20);
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('idle');
  });

  it('(e) terminal exit event with code 0 produces status complete and getStatus returns undefined after unwatch', () => {
    const events: Array<{ status: string }> = [];
    monitor.on('status-change', (e) => events.push(e));

    terminal.emit('exit', 0, '');

    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('complete');

    // unwatch is called after exit, so getStatus should return undefined
    expect(monitor.getStatus(SESSION_ID)).toBeUndefined();
  });

  it('(f) getStatus returns undefined for unwatched session', () => {
    expect(monitor.getStatus('non-existent-session')).toBeUndefined();
  });
});
