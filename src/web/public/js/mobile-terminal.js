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
/** Base WebSocket URL (without ticket) — stored so we can reconnect after visibility restore. */
let _baseWsUrl = null;
/** Auth polling interval for Max sessions — cleared on terminal dispose. */
let _authPollInterval = null;
/** The DOM element we already booted a terminal for — prevents re-creation on unrelated HTMX swaps. */
let _bootedFrame = null;

/* -----------------------------------------------------------------------
   Rolling output buffer — stores the last chunk of terminal output for
   the "Copy" button on the mobile key bar.
   ----------------------------------------------------------------------- */
let _lastOutputChunk = '';
const MAX_OUTPUT_BUFFER = 8000;

/* -----------------------------------------------------------------------
   Wake Lock — keeps the screen on while toggle is active.
   Auto-releases after 5 minutes of no terminal output.
   ----------------------------------------------------------------------- */
let _wakeLock = null;
let _wakeLockIdleTimer = null;
const WAKELOCK_IDLE_MINUTES = 5;

async function _acquireWakeLock() {
  if (!('wakeLock' in navigator)) return false;
  try {
    _wakeLock = await navigator.wakeLock.request('screen');
    _wakeLock.addEventListener('release', () => { _wakeLock = null; _updateWakeLockUI(); });
    _resetWakeLockIdleTimer();
    return true;
  } catch { return false; }
}

function _releaseWakeLock() {
  if (_wakeLockIdleTimer) { clearTimeout(_wakeLockIdleTimer); _wakeLockIdleTimer = null; }
  if (_wakeLock) { _wakeLock.release(); _wakeLock = null; }
  _updateWakeLockUI();
}

function _resetWakeLockIdleTimer() {
  if (_wakeLockIdleTimer) clearTimeout(_wakeLockIdleTimer);
  if (!_wakeLock) return;
  _wakeLockIdleTimer = setTimeout(() => {
    _releaseWakeLock();
    localStorage.removeItem('orcha-wakelock');
    _showToast('Screen lock released (idle)');
  }, WAKELOCK_IDLE_MINUTES * 60 * 1000);
}

function _updateWakeLockUI() {
  const btn = document.getElementById('wakelock-toggle');
  if (btn) btn.classList.toggle('header-toggle--active', !!_wakeLock);
}

window._toggleWakeLock = async function () {
  if (_wakeLock) {
    _releaseWakeLock();
    localStorage.removeItem('orcha-wakelock');
  } else {
    const ok = await _acquireWakeLock();
    if (ok) {
      localStorage.setItem('orcha-wakelock', '1');
      _showToast('Screen will stay on');
    } else {
      _showToast('Wake lock not supported');
    }
  }
  _updateWakeLockUI();
};

/* -----------------------------------------------------------------------
   Notifications — browser Notification API for session events.
   Enabled via header toggle. Fires for:
   - Session completed/failed (via SSE)
   - Auth input needed (via SSE)
   - Idle for 60s after being active (badge indicator only until idle 5min)
   ----------------------------------------------------------------------- */
let _notificationsEnabled = localStorage.getItem('orcha-notifications') === '1';
let _lastOutputTime = 0;
let _idleCheckInterval = null;
const IDLE_SECONDS = 60;
const IDLE_NOTIFY_SECONDS = 300;

function _updateNotifyUI() {
  const btn = document.getElementById('notify-toggle');
  if (btn) btn.classList.toggle('header-toggle--active', _notificationsEnabled);
}

window._toggleNotifications = async function () {
  if (_notificationsEnabled) {
    _notificationsEnabled = false;
    localStorage.removeItem('orcha-notifications');
    _stopIdleCheck();
    _stopNotifySSE();
    _showToast('Notifications off');
  } else {
    if (!('Notification' in window)) {
      _showToast('Notifications not supported');
      return;
    }
    let perm = Notification.permission;
    if (perm === 'default') {
      perm = await Notification.requestPermission();
    }
    if (perm === 'granted') {
      _notificationsEnabled = true;
      localStorage.setItem('orcha-notifications', '1');
      _startIdleCheck();
      _startNotifySSE();
      _showToast('Notifications on');
    } else {
      _showToast('Notification permission denied');
    }
  }
  _updateNotifyUI();
};

function _sendNotification(title, body) {
  if (!_notificationsEnabled || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible') return; // only notify when backgrounded
  try { new Notification(title, { body, icon: '/favicon.ico', tag: 'orcha-' + title }); } catch {}
}

function _startIdleCheck() {
  _stopIdleCheck();
  if (!_notificationsEnabled) return;
  _idleCheckInterval = setInterval(() => {
    if (_lastOutputTime === 0) return;
    const idleSec = (Date.now() - _lastOutputTime) / 1000;

    // Update idle badge on session items
    document.querySelectorAll('.badge--running').forEach((b) => {
      if (idleSec > IDLE_SECONDS) {
        if (!b.dataset.origText) b.dataset.origText = b.textContent;
        b.textContent = 'idle';
        b.style.opacity = '0.6';
      } else if (b.dataset.origText) {
        b.textContent = b.dataset.origText;
        b.style.opacity = '';
        delete b.dataset.origText;
      }
    });

    // Send a notification after prolonged idle
    if (idleSec > IDLE_NOTIFY_SECONDS) {
      _sendNotification('Session idle', 'Your agent session has been idle for 5+ minutes');
      _lastOutputTime = Date.now(); // reset so we don't spam
    }
  }, 5000);
}

function _stopIdleCheck() {
  if (_idleCheckInterval) { clearInterval(_idleCheckInterval); _idleCheckInterval = null; }
}

/* -----------------------------------------------------------------------
   Toast helper — show a brief popup message
   ----------------------------------------------------------------------- */
function _showToast(message) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 2500);
}

/* -----------------------------------------------------------------------
   Copy last output — copies the rolling output buffer to clipboard
   ----------------------------------------------------------------------- */
async function _copyLastOutput() {
  if (!_lastOutputChunk) {
    _showToast('Nothing to copy');
    return;
  }
  try {
    // Strip ANSI escape sequences for clean text
    const clean = _lastOutputChunk.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    await navigator.clipboard.writeText(clean);
    _showToast('Copied to clipboard');
  } catch {
    _showToast('Copy failed');
  }
}

/* -----------------------------------------------------------------------
   Layer visibility helpers — terminal persists in one layer while
   sessions/info/diff content swaps in the other
   ----------------------------------------------------------------------- */

/** Show the terminal layer, hide the content layer. */
function _showTerminalLayer() {
  const termLayer = document.getElementById('mobile-terminal-layer');
  const contentLayer = document.getElementById('mobile-content-layer');
  if (termLayer) termLayer.style.display = '';
  if (contentLayer) contentLayer.style.display = 'none';
}
window._showTerminalLayer = _showTerminalLayer;

/** Show the content layer, hide the terminal layer. */
function _showContentLayer() {
  const termLayer = document.getElementById('mobile-terminal-layer');
  const contentLayer = document.getElementById('mobile-content-layer');
  if (termLayer) termLayer.style.display = 'none';
  if (contentLayer) contentLayer.style.display = '';
}
window._showContentLayer = _showContentLayer;

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
 * Fetch a one-time WS auth ticket and append it to the URL.
 * Falls back to the bare URL if ticket fetch fails (e.g. auth=none).
 */
async function _appendWsTicket(wsUrl) {
  try {
    const r = await fetch('/api/ws-ticket');
    if (r.ok) {
      const data = await r.json();
      if (typeof data.ticket === 'string' && data.ticket) {
        const sep = wsUrl.includes('?') ? '&' : '?';
        return `${wsUrl}${sep}ticket=${data.ticket}`;
      }
    }
  } catch {
    // Proceed without ticket.
  }
  return wsUrl;
}

/**
 * Reconnect the active terminal WebSocket with a fresh auth ticket.
 * Used by visibilitychange and _switchToTerminal when the WS has died.
 */
async function _reconnectWs() {
  if (!_activeTerm || !_activeFitAddon || !_baseWsUrl) return;
  updateBadge('reconnecting');
  const ticketedUrl = await _appendWsTicket(_baseWsUrl);
  connectWs(ticketedUrl, _activeTerm, _activeFitAddon, 0);
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
        // Append to rolling output buffer
        _lastOutputChunk += msg.data;
        if (_lastOutputChunk.length > MAX_OUTPUT_BUFFER) {
          _lastOutputChunk = _lastOutputChunk.slice(-MAX_OUTPUT_BUFFER);
        }
        // Track last output time for idle detection
        _lastOutputTime = Date.now();
        // Reset wake lock idle timer on terminal activity
        if (_wakeLock) _resetWakeLockIdleTimer();
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
        notice.textContent = 'Connection lost.';
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

  // Reset output buffer for new session
  _lastOutputChunk = '';
  _lastOutputTime = 0;

  // Store the base URL (without ticket) so we can reconnect later.
  _baseWsUrl = wsUrl;

  // Fetch a one-time auth ticket (needed when the server runs in OIDC mode,
  // where session cookies aren't available at the WS upgrade layer).
  wsUrl = await _appendWsTicket(wsUrl);

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
    scrollSensitivity: 3,
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
 * Start JS-based auth polling for Max sessions. Only updates the DOM when the
 * response content actually changes, preventing focus loss on the xterm textarea.
 *
 * @param {string} sessionId - The DB session ID.
 */
function _startAuthPolling(sessionId) {
  _stopAuthPolling();
  const slot = document.getElementById('auth-slot-mobile');
  if (!slot) return;

  let lastHtml = '';

  async function poll() {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/auth-url`);
      const html = await res.text();
      // Only touch the DOM when content changed — skipping identical
      // responses avoids the DOM mutations that steal xterm focus on mobile.
      if (html !== lastHtml) {
        lastHtml = html;
        slot.innerHTML = html;
      }
      // Stop polling once auth is resolved or session gone
      if (res.status === 286 || html.includes('auth-banner--success') || html.trim() === '') {
        _stopAuthPolling();
      }
    } catch {
      // Ignore fetch errors (offline, etc.)
    }
  }

  // Check immediately, then every 3 seconds
  poll();
  _authPollInterval = setInterval(poll, 3000);
}

/** Stop the auth polling interval. */
function _stopAuthPolling() {
  if (_authPollInterval) {
    clearInterval(_authPollInterval);
    _authPollInterval = null;
  }
}

/**
 * Dispose the active mobile terminal and WebSocket connection.
 */
function _disposeMobileTerminal() {
  _stopAuthPolling();
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
  _baseWsUrl = null;
  _bootedFrame = null;
}

/**
 * Open the action sheet for a session by fetching it from the server.
 * @param {string} sessionId
 */
function openActionSheet(sessionId) {
  const existing = document.getElementById('action-sheet');
  if (existing) existing.remove();

  htmx.ajax('GET', `/mobile/action-sheet/${sessionId}`, {
    target: '#mobile-shell',
    swap: 'beforeend',
  });
}

/** Remove the action sheet from the DOM. */
function _closeActionSheet() {
  const sheet = document.getElementById('action-sheet');
  if (sheet) sheet.remove();
}

/**
 * Handle the result of stop/reopen actions from the action sheet.
 * Reopen sets HX-Redirect to / on the desktop — intercept and redirect to /mobile/.
 */
window._onActionSheetResult = function (event) {
  const detail = event.detail;
  if (!detail) return;

  _closeActionSheet();

  // Check for HX-Redirect header (reopen sends HX-Redirect: /)
  const xhr = detail.xhr;
  if (xhr) {
    const redirect = xhr.getResponseHeader('HX-Redirect');
    if (redirect) {
      // Prevent HTMX from following the desktop redirect
      event.preventDefault?.();
      window.location.href = '/mobile/';
      return;
    }
  }

  // For stop — just refresh the sessions list
  if (detail.successful) {
    _showContentLayer();
    htmx.ajax('GET', '/mobile/sessions', {
      target: '#mobile-content-layer',
      swap: 'innerHTML',
    });
  }
};

/**
 * Switch to the terminal tab. If a terminal is already booted, just show
 * the terminal layer and re-fit. Otherwise, reconnect to the active session.
 */
window._switchToTerminal = function () {
  // If a terminal is already alive, just reveal it and re-fit
  if (_activeTerm && _bootedFrame) {
    _showTerminalLayer();
    requestAnimationFrame(() => {
      if (_activeFitAddon) _activeFitAddon.fit();
    });
    // If the WebSocket died (e.g. while backgrounded), reconnect with a fresh ticket
    if (_baseWsUrl && (!_activeWs || _activeWs.readyState > WebSocket.OPEN)) {
      _reconnectWs();
    }
    return;
  }

  // Read the mobile-session-id cookie
  const cookieMatch = /mobile-session-id=([^;]+)/.exec(document.cookie);
  const sessionId = cookieMatch?.[1];
  if (!sessionId) {
    // No active session — show placeholder in content layer
    _showContentLayer();
    const layer = document.getElementById('mobile-content-layer');
    if (layer) {
      layer.innerHTML = '<div id="mobile-content-slot"><p class="mobile-placeholder-text">No session connected. Select one from the Sessions tab.</p></div>';
    }
    return;
  }

  // Fetch the terminal frame into the terminal layer
  htmx.ajax('GET', `/mobile/terminal/${sessionId}`, {
    target: '#mobile-terminal-layer',
    swap: 'innerHTML',
  });
};

/**
 * Switch to the Diff tab — load the diff browser for the active session.
 */
window._switchToDiff = function () {
  const cookieMatch = /mobile-session-id=([^;]+)/.exec(document.cookie);
  const sessionId = cookieMatch?.[1];
  if (!sessionId) {
    _showContentLayer();
    const layer = document.getElementById('mobile-content-layer');
    if (layer) {
      layer.innerHTML = '<div id="mobile-content-slot"><p class="mobile-placeholder-text">No session connected. Select one from the Sessions tab.</p></div>';
    }
    return;
  }

  _showContentLayer();
  htmx.ajax('GET', `/api/sessions/${sessionId}/diff-browser`, {
    target: '#mobile-content-layer',
    swap: 'innerHTML',
  });
};

/**
 * Handle the result of stop/reopen/revoke actions from the info panel.
 */
window._onInfoPanelAction = function (event) {
  const detail = event.detail;
  if (!detail) return;

  const xhr = detail.xhr;
  if (xhr) {
    const redirect = xhr.getResponseHeader('HX-Redirect');
    if (redirect) {
      event.preventDefault?.();
      window.location.href = '/mobile/';
      return;
    }
  }

  // Refresh the info panel to show updated state
  if (detail.successful) {
    htmx.ajax('GET', '/mobile/session-info', {
      target: '#mobile-content-layer',
      swap: 'innerHTML',
    });
  }
};

/**
 * Global click delegation for action sheet triggers and buttons.
 */
document.addEventListener('click', (e) => {
  // Kebab button → open action sheet
  const kebab = e.target.closest('.session-kebab-btn');
  if (kebab) {
    e.stopPropagation();
    const sessionId = kebab.dataset.sessionId;
    if (sessionId) openActionSheet(sessionId);
    return;
  }

  // Action sheet backdrop or cancel → close
  if (e.target.closest('.action-sheet-backdrop') || e.target.closest('.action-sheet-btn--cancel')) {
    _closeActionSheet();
    return;
  }

  // Delete button in action sheet
  const deleteBtn = e.target.closest('[data-action="delete"]');
  if (deleteBtn) {
    const sessionId = deleteBtn.dataset.sessionId;
    if (!sessionId) return;
    if (!confirm('Delete this session? This cannot be undone.')) return;

    _closeActionSheet();
    fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' }).then((r) => {
      if (r.ok) {
        // Remove the item from the list
        const item = document.getElementById(`mobile-session-${sessionId}`);
        if (item) item.remove();

        // If this was the active session, clear terminal and cookie
        const cookieMatch = /mobile-session-id=([^;]+)/.exec(document.cookie);
        if (cookieMatch && cookieMatch[1] === sessionId) {
          _disposeMobileTerminal();
          document.cookie = 'mobile-session-id=; Max-Age=0; Path=/mobile';
          _showContentLayer();
          htmx.ajax('GET', '/mobile/sessions', {
            target: '#mobile-content-layer',
            swap: 'innerHTML',
          });
        }
      }
    });
    return;
  }

  // Delete button in info panel
  const deleteInfoBtn = e.target.closest('[data-action="delete-from-info"]');
  if (deleteInfoBtn) {
    const sessionId = deleteInfoBtn.dataset.sessionId;
    if (!sessionId) return;
    if (!confirm('Delete this session? This cannot be undone.')) return;

    fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' }).then((r) => {
      if (r.ok) {
        _disposeMobileTerminal();
        document.cookie = 'mobile-session-id=; Max-Age=0; Path=/mobile';
        _showContentLayer();
        htmx.ajax('GET', '/mobile/sessions', {
          target: '#mobile-content-layer',
          swap: 'innerHTML',
        });
      }
    });
    return;
  }
});

/* -----------------------------------------------------------------------
   Tab active-state management — keep the highlight in sync with clicks
   ----------------------------------------------------------------------- */
(function initTabState() {
  const tabs = document.getElementById('mobile-tabs');
  if (!tabs) return;

  tabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.mobile-tab');
    if (!tab) return;

    // Remove active from all siblings, add to the clicked tab
    tabs.querySelectorAll('.mobile-tab').forEach((t) => t.classList.remove('mobile-tab--active'));
    tab.classList.add('mobile-tab--active');
  });
})();

/**
 * Boot the terminal when #terminal-frame appears in the DOM after an HTMX swap.
 *
 * IMPORTANT: Only enter the terminal-boot path when the swap target is
 * #mobile-terminal-layer.  The afterSwap event fires for EVERY HTMX swap on
 * the page (SSE badge updates, sessions list, info panel, diff, etc.).
 * Without this guard, unrelated swaps can re-trigger _showTerminalLayer() and
 * snap the user back to the terminal view.
 */
document.addEventListener('htmx:afterSwap', (event) => {
  // --- Terminal frame boot (scoped to terminal-layer swaps only) ---
  const swapTarget = event.detail?.target;
  if (swapTarget && swapTarget.id === 'mobile-terminal-layer') {
    const frame = document.getElementById('terminal-frame');
    if (frame && frame !== _bootedFrame) {
      _bootedFrame = frame;
      const sessionId = frame.dataset.sessionId;
      const wsUrl = frame.dataset.wsUrl;

      if (!sessionId || !wsUrl) {
        console.error('[mobile-terminal] terminal-frame missing data-session-id or data-ws-url');
      } else {
        // Show the terminal layer when a new terminal boots
        _showTerminalLayer();

        openMobileTerminal(sessionId, wsUrl);

        // Wire up on-screen key buttons
        const keysBar = document.getElementById('mobile-keys');
        if (keysBar) {
          // Map semantic key names to actual terminal escape sequences.
          const KEY_MAP = {
            'esc': '\x1b',
            'tab': '\t',
            'ctrl-c': '\x03',
            'ctrl-o': '\x0f',
            'arrow-up': '\x1b[A',
            'arrow-down': '\x1b[B',
          };

          keysBar.addEventListener('click', (e) => {
            const btn = e.target.closest('.mobile-key');
            if (!btn) return;
            const keyName = btn.dataset.key;
            if (keyName === 'copy') {
              _copyLastOutput();
              return;
            }
            const data = KEY_MAP[keyName];
            if (data && _activeWs && _activeWs.readyState === WebSocket.OPEN) {
              _activeWs.send(JSON.stringify({ type: 'input', data }));
            }
            // Re-focus the terminal so user can keep typing
            if (_activeTerm) _activeTerm.focus();
          });
        }

        // Start JS-based auth polling for Max sessions (if auth-slot exists).
        const authSlot = document.getElementById('auth-slot-mobile');
        if (authSlot) {
          _startAuthPolling(sessionId);
        }
      }
    }
  }

  // --- Action sheet wiring ---
  const actionSheet = document.getElementById('action-sheet');
  if (actionSheet) {
    htmx.process(actionSheet);
  }

  // --- Info panel wiring ---
  const infoPanel = document.querySelector('.info-panel');
  if (infoPanel) {
    htmx.process(infoPanel);
  }
});

/* -----------------------------------------------------------------------
   Preset chip loading state — disable button while request is in flight
   ----------------------------------------------------------------------- */
document.addEventListener('htmx:beforeRequest', (event) => {
  const elt = event.detail?.elt;
  if (elt && elt.classList.contains('preset-chip')) {
    elt.disabled = true;
    elt.dataset.origText = elt.textContent;
    elt.textContent = 'Launching\u2026';
  }
});

document.addEventListener('htmx:afterRequest', (event) => {
  const elt = event.detail?.elt;
  if (elt && elt.classList.contains('preset-chip')) {
    elt.disabled = false;
    if (elt.dataset.origText) {
      elt.textContent = elt.dataset.origText;
      delete elt.dataset.origText;
    }
  }
});

/* -----------------------------------------------------------------------
   Visibility change — reconnect WebSocket when returning from background.
   On mobile, browsers suspend background tabs and the WS often dies
   silently. When the user returns, reconnect immediately instead of
   showing a stale "disconnected" terminal.
   ----------------------------------------------------------------------- */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!_activeTerm || !_baseWsUrl) return;

  // WebSocket.OPEN = 1, CONNECTING = 0 — anything > OPEN means closing/closed
  if (!_activeWs || _activeWs.readyState > WebSocket.OPEN) {
    _reconnectWs();
  }

  // Re-acquire wake lock (browser releases it when tab goes background)
  if (localStorage.getItem('orcha-wakelock') === '1' && !_wakeLock) {
    _acquireWakeLock();
  }
});

/* -----------------------------------------------------------------------
   SSE notification listener — dedicated EventSource for session status
   changes (completed/failed). Fires browser notifications when backgrounded.
   ----------------------------------------------------------------------- */
let _notifyEventSource = null;

function _startNotifySSE() {
  if (_notifyEventSource) return;
  _notifyEventSource = new EventSource('/api/events');
  _notifyEventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'status') {
        if (data.status === 'completed') {
          _sendNotification('Session completed', 'An agent session has finished successfully.');
        } else if (data.status === 'failed') {
          _sendNotification('Session failed', 'An agent session has failed.');
        }
      }
    } catch {}
  };
  _notifyEventSource.onerror = () => {
    // EventSource auto-reconnects; no action needed
  };
}

function _stopNotifySSE() {
  if (_notifyEventSource) {
    _notifyEventSource.close();
    _notifyEventSource = null;
  }
}

/* -----------------------------------------------------------------------
   Restore persisted toggle states on page load
   ----------------------------------------------------------------------- */
(function _restoreToggles() {
  // Wake lock
  if (localStorage.getItem('orcha-wakelock') === '1') {
    _acquireWakeLock();
  }
  // Notifications
  _updateNotifyUI();
  if (_notificationsEnabled) {
    _startIdleCheck();
    _startNotifySSE();
  }
})();
