/**
 * terminal.js — lazy xterm.js integration for session cards.
 *
 * Relies on xterm.js and @xterm/addon-fit being loaded as UMD globals via
 * <script> tags in layout.html (window.Terminal, window.FitAddon).
 *
 * The server WebSocket handler (terminal-ws.ts) exchanges JSON frames:
 *   client → server: { type: 'input', data: string }
 *                    { type: 'resize', cols: number, rows: number }
 *   server → client: { type: 'output', data: string }
 *                    { type: 'error',  message: string }
 */

/** @type {Map<string, {term: object, ws: WebSocket, fitAddon: object, observer: ResizeObserver}>} */
const openTerminals = new Map();

/**
 * Open a terminal inside the given container element and connect it to the
 * WebSocket endpoint for the specified session.
 *
 * @param {string} sessionId - The session UUID.
 * @param {string} containerId - The id of the DOM element to mount into.
 */
export function openTerminal(sessionId, containerId) {
  if (openTerminals.has(sessionId)) {
    return;
  }

  const container = document.getElementById(containerId);
  if (!container) {
    console.error('[terminal] container not found:', containerId);
    return;
  }

  // Terminal and FitAddon are UMD globals loaded via <script> in layout.html.
  const term = new window.Terminal({
    fontSize: 13,
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() ||
      'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    theme: {
      background: '#000000',
      foreground: '#e2e8f0',
      cursor: '#2563eb',
    },
    cursorBlink: true,
  });

  const fitAddon = new window.FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);
  fitAddon.fit();

  // Build the WebSocket URL — use wss:// when the page is served over HTTPS.
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws/terminal/${sessionId}`);

  // The server sends JSON frames: { type: 'output', data: string }
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'output' && typeof msg.data === 'string') {
        term.write(msg.data);
      }
    } catch {
      // Ignore unparseable messages.
    }
  };

  // Send user input as JSON input frames.
  term.onData((data) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data }));
    }
  });

  // Watch container size changes and relay updated dimensions to the PTY.
  const observer = new ResizeObserver(() => {
    fitAddon.fit();
    if (ws.readyState === WebSocket.OPEN) {
      const dims = fitAddon.proposeDimensions();
      if (dims) {
        ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
      }
    }
  });
  observer.observe(container);

  openTerminals.set(sessionId, { term, ws, fitAddon, observer });
}

/**
 * Close and dispose of the terminal for the given session.
 *
 * @param {string} sessionId
 */
export function closeTerminal(sessionId) {
  const entry = openTerminals.get(sessionId);
  if (!entry) {
    return;
  }

  const { term, ws, observer } = entry;
  ws.close();
  term.dispose();
  observer.disconnect();
  openTerminals.delete(sessionId);
}
