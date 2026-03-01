/**
 * mobile-terminal.js — xterm.js integration for the mobile shell.
 *
 * Relies on xterm.js and @xterm/addon-fit being loaded as UMD globals via
 * <script> tags in mobile.html (window.Terminal, window.FitAddon.FitAddon).
 *
 * The server WebSocket handler (terminal-ws.ts) exchanges JSON frames:
 *   client → server: { type: 'input', data: string }
 *                    { type: 'resize', cols: number, rows: number }
 *   server → client: { type: 'output', data: string }
 *                    { type: 'error',  message: string }
 */

/** Active mobile terminal state — only one terminal open at a time on mobile. */
let _activeTerm = null;
let _activeWs = null;
let _activeFitAddon = null;
let _activeObserver = null;

/**
 * Update the #conn-badge element to reflect the current WebSocket state.
 *
 * @param {'live'|'reconnecting'|'disconnected'} state
 */
function updateBadge(state) {
  const badge = document.getElementById('conn-badge');
  if (!badge) return;
  badge.className = `conn-badge conn-${state}`;
  if (state === 'live') {
    badge.textContent = '\u25CF\u00A0Live';
  } else if (state === 'reconnecting') {
    badge.textContent = '\u25CC\u00A0Reconnecting\u2026';
  } else {
    badge.textContent = '\u25CF\u00A0Disconnected';
  }
}

/**
 * Connect (or reconnect) a WebSocket for the given terminal, with exponential
 * backoff. Up to MAX_RETRIES attempts after the first failure.
 *
 * @param {string}    wsUrl      - Full WebSocket URL.
 * @param {object}    term       - xterm.js Terminal instance.
 * @param {object}    fitAddon   - FitAddon instance already loaded on term.
 * @param {number}    retryCount - How many reconnect attempts have been made so far.
 */
function connectWs(wsUrl, term, fitAddon, retryCount) {
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 3000; // 3s, 6s, 9s

  const ws = new WebSocket(wsUrl);
  _activeWs = ws;

  ws.onopen = () => {
    updateBadge('live');
    // Send initial dimensions once connected.
    const dims = fitAddon.proposeDimensions();
    if (dims) {
      ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
    }
  };

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

  ws.onerror = () => {
    term.write('\r\n[mobile-terminal] WebSocket error — connection lost\r\n');
  };

  ws.onclose = () => {
    // If this WebSocket has already been superseded (user disconnected manually),
    // do not attempt a retry.
    if (_activeWs !== ws) return;

    if (retryCount < MAX_RETRIES) {
      updateBadge('reconnecting');
      const delay = RETRY_DELAY_MS * (retryCount + 1);
      term.write(`\r\n[mobile-terminal] Reconnecting in ${delay / 1000}s… (attempt ${retryCount + 1}/${MAX_RETRIES})\r\n`);
      setTimeout(() => {
        // Only retry if this ws is still the active one (not disposed in the meantime).
        if (_activeWs === ws) {
          connectWs(wsUrl, term, fitAddon, retryCount + 1);
        }
      }, delay);
    } else {
      updateBadge('disconnected');
      term.write('\r\n[mobile-terminal] Disconnected\r\n');
      // Append a user-visible reconnect-failed notice to #terminal-frame.
      const frame = document.getElementById('terminal-frame');
      if (frame) {
        const notice = document.createElement('div');
        notice.className = 'reconnect-failed-msg';
        notice.textContent = 'Connection lost. Swipe down to return to sessions.';
        frame.appendChild(notice);
      }
    }
  };

  return ws;
}

/**
 * Open a mobile terminal inside #xterm-container and connect it to the
 * WebSocket endpoint for the given session.
 *
 * @param {string} _sessionId - The session UUID (reserved for future multi-session support).
 * @param {string} wsUrl - Full WebSocket URL (ws:// or wss://).
 * @returns {Promise<{ disconnect: () => void }>}
 */
async function openMobileTerminal(_sessionId, wsUrl) {
  // Dispose any previously open terminal
  _disposeMobileTerminal();

  // Fetch a one-time auth ticket (needed when the server runs in OIDC mode,
  // where session cookies aren't available at the WS upgrade layer).
  try {
    const r = await fetch('/api/ws-ticket');
    if (r.ok) {
      const data = await r.json();
      if (typeof data.ticket === 'string' && data.ticket) {
        const sep = wsUrl.includes('?') ? '&' : '?';
        wsUrl = `${wsUrl}${sep}ticket=${data.ticket}`;
      }
    }
  } catch {
    // If ticket fetch fails (e.g. auth=none), proceed without one.
  }

  const container = document.getElementById('xterm-container');
  if (!container) {
    console.error('[mobile-terminal] #xterm-container not found');
    return { disconnect: _disposeMobileTerminal };
  }

  // Terminal and FitAddon are UMD globals loaded via <script> in mobile.html.
  const term = new window.Terminal({
    fontSize: 13,
    fontFamily:
      getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() ||
      'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    theme: {
      background: '#0d0d0d',
      foreground: '#e2e8f0',
      cursor: '#2563eb',
      cursorAccent: '#0d0d0d',
      black: '#1a1a2e',
      brightBlack: '#374151',
      red: '#f87171',
      brightRed: '#ef4444',
      green: '#4ade80',
      brightGreen: '#22c55e',
      yellow: '#fbbf24',
      brightYellow: '#f59e0b',
      blue: '#60a5fa',
      brightBlue: '#3b82f6',
      magenta: '#a78bfa',
      brightMagenta: '#8b5cf6',
      cyan: '#34d399',
      brightCyan: '#10b981',
      white: '#d1d5db',
      brightWhite: '#f9fafb',
    },
    cursorBlink: true,
    scrollback: 1000,
    allowProposedApi: false,
  });

  const fitAddon = new window.FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(container);
  fitAddon.fit();

  // Start WebSocket connection with retry support (retryCount starts at 0).
  connectWs(wsUrl, term, fitAddon, 0);

  // Send user input as JSON input frames.
  term.onData((data) => {
    if (_activeWs && _activeWs.readyState === WebSocket.OPEN) {
      _activeWs.send(JSON.stringify({ type: 'input', data }));
    }
  });

  // Watch container size changes and relay updated dimensions to the PTY.
  const observer = new ResizeObserver(() => {
    fitAddon.fit();
    if (_activeWs && _activeWs.readyState === WebSocket.OPEN) {
      const dims = fitAddon.proposeDimensions();
      if (dims) {
        _activeWs.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
      }
    }
  });
  observer.observe(container);

  _activeTerm = term;
  _activeFitAddon = fitAddon;
  _activeObserver = observer;

  return { disconnect: _disposeMobileTerminal };
}

/**
 * Dispose the active mobile terminal and WebSocket connection.
 */
function _disposeMobileTerminal() {
  if (_activeObserver) {
    _activeObserver.disconnect();
    _activeObserver = null;
  }
  if (_activeWs) {
    _activeWs.close();
    _activeWs = null;
  }
  if (_activeTerm) {
    _activeTerm.dispose();
    _activeTerm = null;
  }
  _activeFitAddon = null;
}

/**
 * Attach swipe-down-to-disconnect gesture to the given frame element.
 *
 * @param {HTMLElement} frameEl - The #terminal-frame element.
 * @param {() => void} onDisconnect - Called when the downward swipe is detected.
 */
function initSwipeToDisconnect(frameEl, onDisconnect) {
  let startY = 0;

  frameEl.addEventListener(
    'touchstart',
    (e) => {
      const touch = e.touches[0];
      if (touch) {
        startY = touch.clientY;
      }
    },
    { passive: true },
  );

  frameEl.addEventListener(
    'touchend',
    (e) => {
      const touch = e.changedTouches[0];
      if (!touch) return;
      const endY = touch.clientY;
      // Downward swipe of more than 80px triggers disconnect
      if (endY - startY > 80) {
        onDisconnect();
      }
    },
    { passive: true },
  );
}

/**
 * Open the Send modal by fetching it from the server and injecting it into
 * #mobile-shell as a fixed overlay. After injection, focus the textarea.
 */
function openSendModal() {
  // Remove any stale modal first (idempotent)
  const existing = document.getElementById('send-modal');
  if (existing) existing.remove();

  htmx.ajax('GET', '/mobile/send-modal', {
    target: '#mobile-shell',
    swap: 'beforeend',
  });
}

/** Remove the send modal from the DOM. */
function _closeSendModal() {
  const modal = document.getElementById('send-modal');
  if (modal) modal.remove();
}

// Expose openSendModal globally so onclick= in mobile.html can call it.
window.openSendModal = openSendModal;

/**
 * Boot the terminal when #terminal-frame appears in the DOM after an HTMX swap,
 * or wire up the send modal when it appears.
 */
document.addEventListener('htmx:afterSwap', (event) => {
  // --- Terminal frame boot ---
  const frame = document.getElementById('terminal-frame');
  if (frame) {
    const sessionId = frame.dataset.sessionId;
    const wsUrl = frame.dataset.wsUrl;

    if (!sessionId || !wsUrl) {
      console.error('[mobile-terminal] terminal-frame missing data-session-id or data-ws-url');
    } else {
      openMobileTerminal(sessionId, wsUrl).then(({ disconnect }) => {
        initSwipeToDisconnect(frame, () => {
          disconnect();
          // Navigate back to the sessions list
          htmx.ajax('GET', '/mobile/sessions', {
            target: '#mobile-terminal-area',
            swap: 'innerHTML',
          });
        });
      });

      // Wire up on-screen key buttons
      const keysBar = document.getElementById('mobile-keys');
      if (keysBar) {
        keysBar.addEventListener('click', (e) => {
          const btn = e.target.closest('.mobile-key');
          if (!btn) return;
          const data = btn.dataset.key;
          if (data && _activeWs && _activeWs.readyState === WebSocket.OPEN) {
            _activeWs.send(JSON.stringify({ type: 'input', data }));
          }
          // Re-focus the terminal so user can keep typing
          if (_activeTerm) _activeTerm.focus();
        });
      }
    }
  }

  // --- Send modal wiring ---
  const modal = document.getElementById('send-modal');
  if (modal) {
    // Focus the textarea
    const input = document.getElementById('send-input');
    if (input) {
      // Delay slightly so the element is fully rendered before focus
      setTimeout(() => input.focus(), 50);

      // Submit on Enter (but not Shift+Enter which inserts a newline)
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          const sendBtn = modal.querySelector('.send-submit-btn');
          if (sendBtn) htmx.trigger(sendBtn, 'click');
        }
      });
    }

    // Close on backdrop click
    const backdrop = modal.querySelector('.send-modal-backdrop');
    if (backdrop) {
      backdrop.addEventListener('click', _closeSendModal);
    }

    // Close on cancel button click
    const cancelBtn = modal.querySelector('.send-cancel-btn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', _closeSendModal);
    }
  }
});

/**
 * Auto-dismiss the send modal 600ms after a successful POST /mobile/send.
 */
document.addEventListener('htmx:afterRequest', (event) => {
  const detail = event.detail;
  if (!detail) return;
  // Only react to successful requests targeting /mobile/send.
  // htmx places the request path on detail.pathInfo.requestPath, not
  // on detail.requestConfig.path (which does not exist).
  if (
    detail.successful &&
    detail.pathInfo &&
    detail.pathInfo.requestPath === '/mobile/send'
  ) {
    setTimeout(_closeSendModal, 600);
  }
});
