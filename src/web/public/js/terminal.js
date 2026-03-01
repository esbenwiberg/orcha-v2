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

/** Currently fullscreened session id (only one at a time). */
let fullscreenId = null;

/**
 * Refit a terminal after layout changes (double-rAF to let flex settle).
 * @param {string} sessionId
 */
function refitTerminal(sessionId) {
  const entry = openTerminals.get(sessionId);
  if (!entry) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      entry.fitAddon.fit();
      if (entry.ws.readyState === WebSocket.OPEN) {
        const dims = entry.fitAddon.proposeDimensions();
        if (dims) {
          entry.ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
        }
      }
    });
  });
}

/**
 * Toggle fullscreen for a terminal panel.
 * @param {string} sessionId
 */
function fullscreenTerminal(sessionId) {
  const panel = document.getElementById(`terminal-panel-${sessionId}`);
  if (!panel) return;

  const isCurrentlyFullscreen = panel.classList.contains('is-fullscreen');

  // If another terminal is fullscreen, exit it first
  if (fullscreenId && fullscreenId !== sessionId) {
    exitFullscreen(fullscreenId);
  }

  if (isCurrentlyFullscreen) {
    exitFullscreen(sessionId);
  } else {
    panel.classList.add('is-fullscreen');
    document.body.classList.add('has-fullscreen-terminal');
    fullscreenId = sessionId;

    // Swap icon to collapse
    const btn = panel.querySelector('.terminal-header__btn[title="Fullscreen"]');
    if (btn) {
      btn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="1 4 4 4 4 1" /><polyline points="15 4 12 4 12 1" />
        <polyline points="1 12 4 12 4 15" /><polyline points="15 12 12 12 12 15" />
      </svg>`;
      btn.title = 'Exit fullscreen';
    }

    refitTerminal(sessionId);
  }
}

/**
 * Exit fullscreen for a specific terminal.
 * @param {string} sessionId
 */
function exitFullscreen(sessionId) {
  const panel = document.getElementById(`terminal-panel-${sessionId}`);
  if (!panel) return;

  panel.classList.remove('is-fullscreen');
  document.body.classList.remove('has-fullscreen-terminal');
  if (fullscreenId === sessionId) fullscreenId = null;

  // Swap icon back to expand
  const btn = panel.querySelector('.terminal-header__btn[title="Exit fullscreen"]');
  if (btn) {
    btn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="4 1 1 1 1 4" /><polyline points="12 1 15 1 15 4" />
      <polyline points="4 15 1 15 1 12" /><polyline points="12 15 15 15 15 12" />
    </svg>`;
    btn.title = 'Fullscreen';
  }

  refitTerminal(sessionId);
}

/**
 * Remove a terminal: exit fullscreen, close WS/PTY, remove DOM, update filter bar.
 * @param {string} sessionId
 */
function removeTerminal(sessionId) {
  // Exit fullscreen if this terminal is fullscreened
  if (fullscreenId === sessionId) {
    exitFullscreen(sessionId);
  }

  closeTerminal(sessionId);

  // Clear the terminal slot HTML
  const slot = document.getElementById(`terminal-slot-${sessionId}`);
  if (slot) slot.innerHTML = '';

  // Remove has-terminal from the card
  const card = document.getElementById(`session-${sessionId}`);
  if (card) {
    card.classList.remove('has-terminal');
    card.classList.remove('is-hidden-by-filter');
  }

  updateFilterBar();
}

/**
 * Scan all open terminals and sync the filter bar chips.
 */
function updateFilterBar() {
  const slot = document.getElementById('filter-chips');
  if (!slot) return;

  const cards = document.querySelectorAll('.session-card.has-terminal');

  // If 0 or 1 terminals, clear chips (no filtering needed)
  if (cards.length <= 1) {
    slot.innerHTML = '';
    return;
  }

  // Build set of session IDs that have terminals
  const terminalSessionIds = new Set();
  cards.forEach((card) => {
    const id = card.id.replace('session-', '');
    terminalSessionIds.add(id);
  });

  // Collect existing chip IDs
  const existingChips = slot.querySelectorAll('.terminal-filter-chip[data-session-id]');
  const existingIds = new Set();
  existingChips.forEach((chip) => {
    const chipId = chip.getAttribute('data-session-id');
    if (!terminalSessionIds.has(chipId)) {
      chip.remove();
    } else {
      existingIds.add(chipId);
    }
  });

  // Ensure "All" chip exists
  let allChip = slot.querySelector('.terminal-filter-chip--all');
  if (!allChip) {
    allChip = document.createElement('button');
    allChip.className = 'terminal-filter-chip terminal-filter-chip--all is-active';
    allChip.textContent = 'All';
    allChip.onclick = showAll;
    slot.prepend(allChip);
  }

  // Add chips for new terminals
  cards.forEach((card) => {
    const id = card.id.replace('session-', '');
    if (existingIds.has(id)) return;

    const branchEl = card.querySelector('.card__meta');
    const branchText = branchEl ? branchEl.textContent.trim() : id.slice(0, 8);

    const chip = document.createElement('button');
    chip.className = 'terminal-filter-chip is-active';
    chip.setAttribute('data-session-id', id);
    chip.textContent = branchText;
    chip.onclick = () => toggleFilter(id);
    slot.appendChild(chip);
  });
}

/**
 * Toggle visibility of a session card via the filter bar.
 * @param {string} sessionId
 */
function toggleFilter(sessionId) {
  const card = document.getElementById(`session-${sessionId}`);
  const chip = document.querySelector(`.terminal-filter-chip[data-session-id="${sessionId}"]`);
  if (!card || !chip) return;

  const isHidden = card.classList.toggle('is-hidden-by-filter');
  chip.classList.toggle('is-active', !isHidden);

  // Update "All" chip state: active only if all chips are active
  const filterSlot = document.getElementById('filter-chips');
  const allChip = filterSlot && filterSlot.querySelector('.terminal-filter-chip--all');
  if (allChip) {
    const allChips = filterSlot.querySelectorAll('.terminal-filter-chip[data-session-id]');
    const allActive = Array.from(allChips).every((c) => c.classList.contains('is-active'));
    allChip.classList.toggle('is-active', allActive);
  }

  // Refit visible terminals (hidden ones don't need it)
  if (!isHidden) {
    refitTerminal(sessionId);
  }
}

/**
 * Show all terminals (reset filter).
 */
function showAll() {
  document.querySelectorAll('.session-card.is-hidden-by-filter').forEach((card) => {
    card.classList.remove('is-hidden-by-filter');
  });
  document.querySelectorAll('.terminal-filter-chip').forEach((chip) => {
    chip.classList.add('is-active');
  });

  // Refit all visible terminals
  openTerminals.forEach((_entry, id) => refitTerminal(id));
}

// ESC key exits fullscreen
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && fullscreenId) {
    exitFullscreen(fullscreenId);
  }
});

// Global bindings for template onclick handlers
window.__termFullscreen = fullscreenTerminal;
window.__termClose = removeTerminal;

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

  // Double-rAF: flex layout needs a frame to settle before fit() measures correctly
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      fitAddon.fit();
    });
  });

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

  // Send an initial resize so the PTY matches the actual container dimensions
  // right from the start, before any output is replayed. Without this, the PTY
  // defaults to a tall size (50 rows) and the terminal shows lots of blank rows
  // above the actual content.
  ws.onopen = () => {
    const dims = fitAddon.proposeDimensions();
    if (dims) {
      ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
    }
  };

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

  updateFilterBar();
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
