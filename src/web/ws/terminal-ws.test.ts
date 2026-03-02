import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { handleTerminalConnection } from './terminal-ws.js';
import type { SessionManager, ActiveSession } from '../../terminal/session-manager.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Minimal readable-stream stub that exposes an `on` / `removeListener` interface. */
class MockOutputStream extends EventEmitter {}

function buildMockSession(): ActiveSession {
  const outputStream = new MockOutputStream();

  const terminal = {
    sessionId: 'test-session',
    pid: 1234,
    exitCode: undefined,
    output: outputStream,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    on: vi.fn(),
  };

  return {
    sessionId: 'test-session',
    dbSessionId: undefined,
    worktree: {} as ActiveSession['worktree'],
    terminal: terminal as unknown as ActiveSession['terminal'],
    outputBuffer: { snapshot: vi.fn().mockReturnValue(Buffer.alloc(0)), push: vi.fn() } as unknown as ActiveSession['outputBuffer'],
    createdAt: new Date(),
  };
}

/** Minimal WebSocket stub that tracks sent messages and emits events. */
class MockWebSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  send = vi.fn();
  close = vi.fn();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleTerminalConnection', () => {
  let session: ActiveSession;
  let engine: SessionManager;
  let ws: MockWebSocket;

  beforeEach(() => {
    session = buildMockSession();
    engine = {
      getSession: vi.fn().mockReturnValue(session),
      getSessionByDbId: vi.fn().mockReturnValue(undefined),
      createSession: vi.fn(),
      listSessions: vi.fn(),
      stopSession: vi.fn(),
      getOutputSnapshot: vi.fn(),
      stopAllSessions: vi.fn(),
    } as unknown as SessionManager;
    ws = new MockWebSocket();
  });

  it('sends an error message and closes with 4004 when session is not found', () => {
    vi.mocked(engine.getSession).mockReturnValue(undefined);

    handleTerminalConnection(ws as unknown as WebSocket, 'missing-id', engine);

    expect(ws.send).toHaveBeenCalledOnce();
    const payload = JSON.parse(ws.send.mock.calls[0]?.[0] as string) as {
      type: string;
      message: string;
    };
    expect(payload.type).toBe('error');
    expect(payload.message).toBe('Session not found');
    expect(ws.close).toHaveBeenCalledWith(4004);
  });

  it('subscribes to terminal output and forwards it as JSON output frames', () => {
    handleTerminalConnection(ws as unknown as WebSocket, 'test-session', engine);

    // Simulate PTY output arriving on the stream
    (session.terminal.output as unknown as MockOutputStream).emit('data', 'hello\r\n');

    expect(ws.send).toHaveBeenCalledOnce();
    const payload = JSON.parse(ws.send.mock.calls[0]?.[0] as string) as {
      type: string;
      data: string;
    };
    expect(payload.type).toBe('output');
    expect(payload.data).toBe('hello\r\n');
  });

  it('does not forward output when WebSocket is not OPEN', () => {
    handleTerminalConnection(ws as unknown as WebSocket, 'test-session', engine);

    ws.readyState = WebSocket.CLOSED;
    (session.terminal.output as unknown as MockOutputStream).emit('data', 'ignored');

    expect(ws.send).not.toHaveBeenCalled();
  });

  it('calls terminal.resize with correct TerminalSize on resize message', () => {
    handleTerminalConnection(ws as unknown as WebSocket, 'test-session', engine);

    const msg = Buffer.from(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
    ws.emit('message', msg);

    expect(session.terminal.resize).toHaveBeenCalledOnce();
    expect(session.terminal.resize).toHaveBeenCalledWith({ cols: 80, rows: 24 });
  });

  it('calls terminal.write on input message', () => {
    handleTerminalConnection(ws as unknown as WebSocket, 'test-session', engine);

    const msg = Buffer.from(JSON.stringify({ type: 'input', data: 'ls -la\n' }));
    ws.emit('message', msg);

    expect(session.terminal.write).toHaveBeenCalledOnce();
    expect(session.terminal.write).toHaveBeenCalledWith('ls -la\n');
  });

  it('ignores resize messages with out-of-range cols/rows', () => {
    handleTerminalConnection(ws as unknown as WebSocket, 'test-session', engine);

    const msg = Buffer.from(JSON.stringify({ type: 'resize', cols: 0, rows: 24 }));
    ws.emit('message', msg);

    expect(session.terminal.resize).not.toHaveBeenCalled();
  });

  it('ignores resize messages with cols > 500', () => {
    handleTerminalConnection(ws as unknown as WebSocket, 'test-session', engine);

    const msg = Buffer.from(JSON.stringify({ type: 'resize', cols: 501, rows: 24 }));
    ws.emit('message', msg);

    expect(session.terminal.resize).not.toHaveBeenCalled();
  });

  it('ignores malformed JSON messages without throwing', () => {
    handleTerminalConnection(ws as unknown as WebSocket, 'test-session', engine);

    expect(() => {
      ws.emit('message', Buffer.from('not-json'));
    }).not.toThrow();
    expect(session.terminal.write).not.toHaveBeenCalled();
  });

  it('removes the data listener on close to prevent memory leaks', () => {
    handleTerminalConnection(ws as unknown as WebSocket, 'test-session', engine);

    const listenersBefore = (
      session.terminal.output as unknown as MockOutputStream
    ).listenerCount('data');

    ws.emit('close');

    const listenersAfter = (
      session.terminal.output as unknown as MockOutputStream
    ).listenerCount('data');

    expect(listenersBefore).toBe(1);
    expect(listenersAfter).toBe(0);
  });
});
