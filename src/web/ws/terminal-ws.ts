import WebSocket from 'ws';
import type { SessionTerminal } from '../../terminal/session-terminal.js';
import type { OutputBuffer } from '../../terminal/output-buffer.js';
import type { SessionManager } from '../../terminal/session-manager.js';

/**
 * High-water mark (bytes) for the WebSocket send buffer.
 * When bufferedAmount exceeds this, we pause the PTY stream to avoid
 * unbounded memory growth that causes 1006 disconnects on verbose builds.
 */
const WS_HIGH_WATER_MARK = 1024 * 1024; // 1 MB

/**
 * Bridge a PTY terminal to a WebSocket connection.
 *
 * Subscribes to output, replays buffered data, routes input/resize messages,
 * and cleans up listeners on WS close. Implements backpressure: pauses the
 * PTY stream when the WS send buffer is full, resumes on drain.
 */
export function bridgeTerminalToWebSocket(
  ws: WebSocket,
  terminal: SessionTerminal,
  outputBuffer: OutputBuffer,
): void {
  let paused = false;

  const maybePause = (): void => {
    if (!paused && ws.bufferedAmount > WS_HIGH_WATER_MARK) {
      paused = true;
      terminal.output.pause();
    }
  };

  const onDrain = (): void => {
    if (paused) {
      paused = false;
      terminal.output.resume();
    }
  };
  ws.on('drain', onDrain);

  const onData = (chunk: Buffer | string): void => {
    if (ws.readyState === WebSocket.OPEN) {
      const data = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      ws.send(JSON.stringify({ type: 'output', data }));
      maybePause();
    }
  };

  // Subscribe first, then replay the buffer — Node's single-threaded event
  // loop ensures no data is missed between snapshot and subscription.
  terminal.output.on('data', onData);

  // When the PTY exits, notify the client.
  const sendExitMessage = (): void => {
    if (ws.readyState === WebSocket.OPEN) {
      const code = terminal.exitCode;
      ws.send(JSON.stringify({ type: 'output', data: `\r\n\x1b[33m[process exited${code !== undefined ? ` (code ${code})` : ''}]\x1b[0m\r\n` }));
    }
  };
  const onEnd = (): void => sendExitMessage();
  terminal.output.once('end', onEnd);

  // Replay buffered output so the client sees everything emitted before it connected.
  const snapshot = outputBuffer.snapshot();
  if (snapshot.length > 0 && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'output', data: snapshot.toString('utf8') }));
  }

  // If the PTY already exited before the WS connected, send exit message immediately.
  if (terminal.exitCode !== undefined) {
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
        terminal.write(data);
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
        terminal.resize({ cols, rows });
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

  const cleanup = (): void => {
    terminal.output.removeListener('data', onData);
    terminal.output.removeListener('end', onEnd);
    ws.removeListener('drain', onDrain);
    if (paused) {
      paused = false;
      terminal.output.resume();
    }
  };

  // Clean up listeners when the client disconnects to prevent memory leaks.
  ws.on('close', cleanup);
  ws.on('error', cleanup);
}

/**
 * Handle a WebSocket connection for a terminal session.
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

  bridgeTerminalToWebSocket(ws, session.terminal, session.outputBuffer);
}

/**
 * Handle a WebSocket connection for a debug shell.
 */
export function handleDebugShellConnection(
  ws: WebSocket,
  shellId: string,
  engine: SessionManager,
): void {
  const shell = engine.getDebugShell(shellId);

  if (shell === undefined) {
    ws.send(JSON.stringify({ type: 'error', message: 'Debug shell not found' }));
    ws.close(4004);
    return;
  }

  bridgeTerminalToWebSocket(ws, shell.terminal, shell.outputBuffer);
}
