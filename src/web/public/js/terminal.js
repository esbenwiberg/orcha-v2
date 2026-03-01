/**
 * terminal.js — lazy xterm.js integration for session cards.
 *
 * Relies on xterm.js and @xterm/addon-fit being loaded as UMD globals via
 * <script> tags in layout.html (window.Terminal, window.FitAddon).
 *
 * The server WebSocket handler (terminal-ws.ts) exchanges JSON frames:
 *   client -> server: { type: 'input', data: string }
 *                    { type: 'resize', cols: number, rows: number }
 *   server -> client: { type: 'output', data: string }
 *                    { type: 'error',  message: string }
 *
 * Keyboard shortcuts (tmux-style Ctrl+A prefix):
 *   Ctrl+A, Enter     — toggle fullscreen on focused session
 *   Ctrl+A, Arrow     — navigate to adjacent session in grid
 *   Ctrl+A, 1-9       — jump to session by position
 *   Ctrl+A, W         — close terminal panel (disconnect, keep session)
 *   Ctrl+A, X         — stop session (SIGTERM)
 *   Ctrl+A, Ctrl+A    — send literal Ctrl+A to terminal
 */

/** @type {Map<string, {term: object, ws: WebSocket, fitAddon: object, observer: ResizeObserver}>} */
const openTerminals = new Map();

/** Currently fullscreened session id (only one at a time). */
let fullscreenId = null;

/* -----------------------------------------------------------------------
   Prefix-mode state (Ctrl+A shortcuts)
   ----------------------------------------------------------------------- */
let prefixActive = false;
let prefixTimeout = null;

/** Which session card currently has keyboard focus. */
let focusedSessionId = null;

/* -----------------------------------------------------------------------
   Toast notifications
   ----------------------------------------------------------------------- */

/**
 * Show a brief toast notification.
 * @param {string} message
 * @param {'success'|'error'} [type='success']
 */
function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.textContent = message;
  container.appendChild(el);

  setTimeout(() => {
    el.classList.add('is-exiting');
    setTimeout(() => el.remove(), 300);
  }, 2500);
}

/* -----------------------------------------------------------------------
   Focus tracking
   ----------------------------------------------------------------------- */

/**
 * Set keyboard focus to a session card.
 * @param {string} sessionId
 */
function focusSession(sessionId) {
  // Remove old focus
  if (focusedSessionId) {
    const oldCard = document.getElementById(`session-${focusedSessionId}`);
    if (oldCard) oldCard.classList.remove('is-focused');
  }

  focusedSessionId = sessionId;

  const card = document.getElementById(`session-${sessionId}`);
  if (card) card.classList.add('is-focused');

  // Focus the xterm instance so it receives keyboard input
  const entry = openTerminals.get(sessionId);
  if (entry) entry.term.focus();
}

/**
 * Get visible session cards that have terminals, in DOM order.
 * @returns {string[]} array of session IDs
 */
function getVisibleTerminalIds() {
  const cards = document.querySelectorAll('.session-card.has-terminal:not(.is-hidden-by-filter)');
  return Array.from(cards).map((c) => c.id.replace('session-', ''));
}

/* -----------------------------------------------------------------------
   Grid navigation
   ----------------------------------------------------------------------- */

/**
 * Navigate to an adjacent session card in the grid.
 * @param {'ArrowUp'|'ArrowDown'|'ArrowLeft'|'ArrowRight'} direction
 */
function navigateGrid(direction) {
  const ids = getVisibleTerminalIds();
  if (ids.length === 0) return;

  const currentIdx = focusedSessionId ? ids.indexOf(focusedSessionId) : -1;
  if (currentIdx === -1) {
    focusSession(ids[0]);
    return;
  }

  // Infer column count from the grid's data-count attribute or computed style
  const grid = document.getElementById('session-grid');
  let cols = 1;
  if (grid) {
    const style = getComputedStyle(grid);
    const templateCols = style.getPropertyValue('grid-template-columns').trim();
    if (templateCols) {
      cols = templateCols.split(/\s+/).length;
    }
  }

  const row = Math.floor(currentIdx / cols);
  const col = currentIdx % cols;
  let nextIdx = currentIdx;

  switch (direction) {
    case 'ArrowLeft':
      nextIdx = currentIdx - 1;
      break;
    case 'ArrowRight':
      nextIdx = currentIdx + 1;
      break;
    case 'ArrowUp':
      nextIdx = currentIdx - cols;
      break;
    case 'ArrowDown':
      nextIdx = currentIdx + cols;
      break;
  }

  // Wrap at edges
  if (nextIdx < 0) nextIdx = ids.length - 1;
  if (nextIdx >= ids.length) nextIdx = 0;

  if (nextIdx !== currentIdx) {
    focusSession(ids[nextIdx]);
  }
}

/* -----------------------------------------------------------------------
   Prefix-mode action dispatch
   ----------------------------------------------------------------------- */

/**
 * Enter prefix mode (Ctrl+A pressed). The next key triggers an action.
 */
function enterPrefixMode() {
  prefixActive = true;
  if (prefixTimeout) clearTimeout(prefixTimeout);
  prefixTimeout = setTimeout(() => {
    prefixActive = false;
    prefixTimeout = null;
  }, 2000);
}

/**
 * Dispatch an action based on the key pressed after Ctrl+A.
 * @param {KeyboardEvent} e
 * @returns {boolean} true if action was handled
 */
function dispatchPrefixAction(e) {
  prefixActive = false;
  if (prefixTimeout) {
    clearTimeout(prefixTimeout);
    prefixTimeout = null;
  }

  const key = e.key;

  // Ctrl+A, Ctrl+A — send literal Ctrl+A to terminal
  if (key === 'a' && e.ctrlKey) {
    const entry = focusedSessionId ? openTerminals.get(focusedSessionId) : null;
    if (entry && entry.ws.readyState === WebSocket.OPEN) {
      entry.ws.send(JSON.stringify({ type: 'input', data: '\x01' }));
    }
    return true;
  }

  // Ctrl+A, Enter — toggle fullscreen
  if (key === 'Enter') {
    if (focusedSessionId) fullscreenTerminal(focusedSessionId);
    return true;
  }

  // Ctrl+A, Arrow keys — navigate grid
  if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowRight') {
    navigateGrid(key);
    return true;
  }

  // Ctrl+A, 1-9 — jump to session by position
  if (key >= '1' && key <= '9') {
    const ids = getVisibleTerminalIds();
    const idx = parseInt(key, 10) - 1;
    if (idx < ids.length) focusSession(ids[idx]);
    return true;
  }

  // Ctrl+A, W — close terminal panel (disconnect, keep session)
  if (key === 'w' || key === 'W') {
    if (focusedSessionId) {
      removeTerminal(focusedSessionId);
      focusedSessionId = null;
    }
    return true;
  }

  // Ctrl+A, X — stop session (SIGTERM via HTMX)
  if (key === 'x' || key === 'X') {
    if (focusedSessionId) {
      const stopBtn = document.querySelector(`#session-${focusedSessionId} [hx-post*="/stop"]`);
      if (stopBtn) {
        stopBtn.click();
      } else {
        // Fall back: fetch the confirm dialog which has the stop button
        const confirmBtn = document.querySelector(`#session-${focusedSessionId} [hx-get*="confirm"]`);
        if (confirmBtn) confirmBtn.click();
      }
    }
    return true;
  }

  return false;
}

/* -----------------------------------------------------------------------
   Document-level keyboard listener (capture phase)
   ----------------------------------------------------------------------- */
document.addEventListener(
  'keydown',
  (e) => {
    // ESC exits fullscreen
    if (e.key === 'Escape' && fullscreenId) {
      exitFullscreen(fullscreenId);
      return;
    }

    // In prefix mode — dispatch action
    if (prefixActive) {
      e.preventDefault();
      e.stopPropagation();
      dispatchPrefixAction(e);
      return;
    }

    // Ctrl+A activates prefix mode (only if not in a regular input/textarea)
    if (e.key === 'a' && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      e.preventDefault();
      e.stopPropagation();
      enterPrefixMode();
      return;
    }
  },
  true,
);

/* -----------------------------------------------------------------------
   Image paste handler
   ----------------------------------------------------------------------- */

/**
 * Handle Ctrl+V / Cmd+V: check clipboard for images, upload if found,
 * otherwise fall back to text paste.
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
async function handlePaste(sessionId) {
  const entry = openTerminals.get(sessionId);
  if (!entry || entry.ws.readyState !== WebSocket.OPEN) return;

  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const imageType = item.types.find((t) => t.startsWith('image/'));
      if (imageType) {
        const blob = await item.getType(imageType);
        const ext = imageType.split('/')[1] || 'png';
        const reader = new FileReader();
        reader.onload = async () => {
          try {
            const resp = await fetch('/api/upload-image', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ data: reader.result, filename: `paste.${ext}` }),
            });
            if (resp.ok) {
              const { path } = await resp.json();
              entry.ws.send(JSON.stringify({ type: 'input', data: path }));
              showToast(`Image saved: ${path}`);
            } else {
              showToast('Image upload failed', 'error');
            }
          } catch {
            showToast('Image upload failed', 'error');
          }
        };
        reader.readAsDataURL(blob);
        return;
      }
    }
  } catch {
    // clipboard.read() not available or denied — fall back to text
  }

  // No image found — paste text
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      entry.ws.send(JSON.stringify({ type: 'input', data: text }));
    }
  } catch {
    // Clipboard read failed
  }
}

// Global bindings for template onclick handlers
window.__termFullscreen = fullscreenTerminal;
window.__termClose = removeTerminal;

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
    card.classList.remove('is-focused');
  }

  // If this was the focused session, clear focus
  if (focusedSessionId === sessionId) focusedSessionId = null;

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

  if (window.__syncGridCount) window.__syncGridCount();
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

  if (window.__syncGridCount) window.__syncGridCount();
}

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

  // Intercept keys before xterm processes them (Ctrl+A prefix, Ctrl+V paste)
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;

    // While prefix is active, swallow the next key (document listener handles it)
    if (prefixActive) return false;

    // Ctrl+A activates prefix mode
    if (e.key === 'a' && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      enterPrefixMode();
      return false;
    }

    // Ctrl+V / Cmd+V — intercept for image paste support
    if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
      handlePaste(sessionId);
      return false;
    }

    return true;
  });

  // Auto-copy on selection
  term.onSelectionChange(() => {
    const sel = term.getSelection();
    if (sel) {
      navigator.clipboard.writeText(sel).then(
        () => showToast('Copied'),
        () => {},
      );
    }
  });

  // Track focus: when user clicks into this terminal, mark it as focused
  term.textarea?.addEventListener('focus', () => {
    focusSession(sessionId);
  });

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

  // Auto-focus the newly opened terminal
  focusSession(sessionId);

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
