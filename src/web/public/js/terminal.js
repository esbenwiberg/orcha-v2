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
export async function openTerminal(sessionId, containerId) {
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

  // Fetch a one-time auth ticket (needed when the server runs in OIDC mode,
  // where session cookies aren't available at the WS upgrade layer).
  let ticket = '';
  try {
    const r = await fetch('/api/ws-ticket');
    if (r.ok) {
      const data = await r.json();
      ticket = typeof data.ticket === 'string' ? data.ticket : '';
    }
  } catch {
    // If ticket fetch fails (e.g. auth=none), proceed without one.
  }

  // Build the WebSocket URL — use wss:// when the page is served over HTTPS.
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = ticket
    ? `${proto}//${location.host}/ws/terminal/${sessionId}?ticket=${ticket}`
    : `${proto}//${location.host}/ws/terminal/${sessionId}`;
  const ws = new WebSocket(wsUrl);

  // The server sends JSON frames: { type: 'output', data: string } or { type: 'error', message: string }
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'output' && typeof msg.data === 'string') {
        term.write(msg.data);
      } else if (msg.type === 'error' && typeof msg.message === 'string') {
        term.write(`\r\n\x1b[31m[error] ${msg.message}\x1b[0m\r\n`);
      }
    } catch {
      // Ignore unparseable messages.
    }
  };

  ws.onerror = () => {
    term.write('\r\n\x1b[31m[terminal] WebSocket connection failed\x1b[0m\r\n');
  };

  ws.onclose = (event) => {
    if (event.code !== 1000 && event.code !== 1001) {
      term.write(`\r\n\x1b[33m[terminal] Connection closed (code ${event.code})\x1b[0m\r\n`);
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
