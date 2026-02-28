import WebSocket from 'ws';
import type { SessionManager } from '../../terminal/session-manager.js';

/**
 * Handle a WebSocket connection for a terminal session.
 *
 * Bridges PTY output → WebSocket JSON frames and WebSocket input/resize
 * messages → PTY writes/resizes.
 */
export function handleTerminalConnection(
  ws: WebSocket,
  sessionId: string,
  engine: SessionManager,
): void {
  const session = engine.getSession(sessionId) ?? engine.getSessionByDbId(sessionId);

  if (session === undefined) {
    ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
    ws.close(4004);
    return;
  }

  // Subscribe to PTY stdout via the readable stream.
  // We keep a reference to the listener so we can remove it on close.
  const onData = (chunk: Buffer | string): void => {
    if (ws.readyState === WebSocket.OPEN) {
      const data = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      ws.send(JSON.stringify({ type: 'output', data }));
    }
  };

  // Subscribe first, then replay the buffer — Node's single-threaded event
  // loop ensures no data is missed between snapshot and subscription.
  session.terminal.output.on('data', onData);

  // When the PTY exits, notify the client so the terminal shows a close message
  // instead of sitting silently black forever.
  const sendExitMessage = (): void => {
    if (ws.readyState === WebSocket.OPEN) {
      const code = session.terminal.exitCode;
      ws.send(JSON.stringify({ type: 'output', data: `\r\n\x1b[33m[process exited${code !== undefined ? ` (code ${code})` : ''}]\x1b[0m\r\n` }));
    }
  };
  const onEnd = (): void => sendExitMessage();
  session.terminal.output.once('end', onEnd);

  // Replay buffered output so the client sees everything emitted before it connected.
  const snapshot = session.outputBuffer.snapshot();
  if (snapshot.length > 0 && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'output', data: snapshot.toString('utf8') }));
  }

  // If the PTY already exited before the WS connected, the 'end' event was
  // already emitted and we missed it. Send the exit message immediately.
  if (session.terminal.exitCode !== undefined) {
    sendExitMessage();
  }

  // Route browser messages to the PTY.
  ws.on('message', (raw: Buffer) => {
    let msg: unknown;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      process.stderr.write(`[ws] Malformed message (not valid JSON): ${String(err)}\n`);
      return;
    }

    if (typeof msg !== 'object' || msg === null) {
      process.stderr.write('[ws] Received non-object message; ignoring\n');
      return;
    }

    const record = msg as Record<string, unknown>;

    switch (record['type']) {
      case 'input': {
        const data = record['data'];
        if (typeof data !== 'string') {
          process.stderr.write('[ws] input message missing string data field; ignoring\n');
          return;
        }
        session.terminal.write(data);
        break;
      }

      case 'resize': {
        const cols = record['cols'];
        const rows = record['rows'];
        if (
          typeof cols !== 'number' ||
          typeof rows !== 'number' ||
          !Number.isInteger(cols) ||
          !Number.isInteger(rows) ||
          cols < 1 ||
          cols > 500 ||
          rows < 1 ||
          rows > 500
        ) {
          process.stderr.write(
            `[ws] resize message has invalid cols/rows (cols=${String(cols)}, rows=${String(rows)}); ignoring\n`,
          );
          return;
        }
        session.terminal.resize({ cols, rows });
        break;
      }

      default: {
        process.stderr.write(
          `[ws] Unrecognised message type: ${String(record['type'])}; ignoring\n`,
        );
        break;
      }
    }
  });

  // Clean up listeners when the client disconnects to prevent memory leaks.
  ws.on('close', () => {
    session.terminal.output.removeListener('data', onData);
    session.terminal.output.removeListener('end', onEnd);
  });
}
