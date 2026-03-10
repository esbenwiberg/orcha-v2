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

/* -----------------------------------------------------------------------
   Voice-to-text (Web Speech API)
   ----------------------------------------------------------------------- */

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

/** Active voice recognition state (only one can run at a time). */
let voiceState = null; // { recognition, sessionId }

/**
 * Toggle voice input for a session terminal.
 * @param {string} sessionId
 */
function toggleVoice(sessionId) {
  if (!SpeechRecognition) return;

  // If already recording for this session, stop
  if (voiceState && voiceState.sessionId === sessionId) {
    voiceState.recognition.stop();
    return;
  }

  // If recording for a different session, stop that first
  if (voiceState) {
    voiceState.recognition.stop();
  }

  const entry = openTerminals.get(sessionId);
  if (!entry || entry.ws.readyState !== WebSocket.OPEN) return;

  const recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language || 'en-US';

  voiceState = { recognition, sessionId };
  _setVoiceUI(sessionId, true);

  recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        // Send final text to terminal
        const e = openTerminals.get(sessionId);
        if (e && e.ws.readyState === WebSocket.OPEN) {
          e.ws.send(JSON.stringify({ type: 'input', data: transcript }));
        }
        _setTranscript(sessionId, '');
      } else {
        interim += transcript;
      }
    }
    if (interim) {
      _setTranscript(sessionId, interim);
    }
  };

  recognition.onerror = (event) => {
    if (event.error !== 'aborted' && event.error !== 'no-speech') {
      showToast(`Voice error: ${event.error}`, 'error');
    }
  };

  recognition.onend = () => {
    _setVoiceUI(sessionId, false);
    _setTranscript(sessionId, '');
    if (voiceState && voiceState.sessionId === sessionId) {
      voiceState = null;
    }
  };

  recognition.start();
}

/**
 * Update the mic button appearance for recording state.
 * @param {string} sessionId
 * @param {boolean} recording
 */
function _setVoiceUI(sessionId, recording) {
  const btn = document.querySelector(`#terminal-panel-${sessionId} .terminal-header__btn--mic`);
  if (btn) {
    btn.classList.toggle('is-recording', recording);
    btn.title = recording ? 'Stop voice input' : 'Voice input';
  }
}

/**
 * Show or clear interim transcript overlay.
 * @param {string} sessionId
 * @param {string} text
 */
function _setTranscript(sessionId, text) {
  const panel = document.getElementById(`terminal-panel-${sessionId}`);
  if (!panel) return;

  let overlay = panel.querySelector('.voice-transcript');
  if (!text) {
    if (overlay) overlay.remove();
    return;
  }

  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'voice-transcript';
    panel.appendChild(overlay);
  }
  overlay.textContent = text;
}

/** Currently fullscreened session id (only one at a time). */
let fullscreenId = null;

/** Get the session grid container. */
function getSessionGrid() {
  return document.getElementById('session-grid');
}

/** Get the parent .session-card for a panel element. */
function getParentCard(el) {
  return el ? el.closest('.session-card') : null;
}

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

  // Ctrl+A, X — stop session (SIGTERM)
  if (key === 'x' || key === 'X') {
    if (focusedSessionId) {
      fetch(`/api/sessions/${focusedSessionId}/stop`, { method: 'POST' })
        .then((r) => { if (r.ok) return r.text(); })
        .then((html) => {
          if (html) {
            const card = document.getElementById(`session-${focusedSessionId}`);
            if (card) { card.outerHTML = html; }
          }
        })
        .catch(() => {});
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
              const errBody = await resp.text().catch(() => '');
              showToast(`Image upload failed (${resp.status}): ${errBody || resp.statusText}`, 'error');
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

/* -----------------------------------------------------------------------
   Close menu (replaces Stop/Kill/Delete footer)
   ----------------------------------------------------------------------- */

/**
 * Show a small dropdown menu anchored to the X button with Close / Stop / Delete.
 * @param {string} sessionId
 * @param {HTMLElement} anchorBtn
 */
function showCloseMenu(sessionId, anchorBtn) {
  // Remove any existing menu
  const existing = document.getElementById('term-close-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.id = 'term-close-menu';
  menu.className = 'term-close-menu';

  // Close (disconnect only)
  const closeItem = document.createElement('button');
  closeItem.className = 'term-close-menu__item';
  closeItem.textContent = 'Close';
  closeItem.addEventListener('click', () => {
    menu.remove();
    removeTerminal(sessionId);
  });
  menu.appendChild(closeItem);

  // Debug shell — available for running, completed, failed, cancelled sessions
  const badge = document.getElementById(`badge-${sessionId}`);
  const status = badge ? badge.textContent.trim() : '';
  if (status === 'running' || status === 'completed' || status === 'failed' || status === 'cancelled') {
    const shellItem = document.createElement('button');
    shellItem.className = 'term-close-menu__item';
    shellItem.textContent = 'Session Shell';
    shellItem.addEventListener('click', () => {
      menu.remove();
      fetch(`/api/sessions/${sessionId}/debug-shell`, { method: 'POST' })
        .then((r) => {
          if (r.ok) return r.text();
          throw new Error('Failed to spawn shell');
        })
        .then((html) => {
          if (html) {
            let container = document.getElementById(`debug-shells-${sessionId}`);
            if (!container) {
              // Create container after terminal-slot if missing
              const termSlot = document.getElementById(`terminal-slot-${sessionId}`);
              if (termSlot) {
                container = document.createElement('div');
                container.id = `debug-shells-${sessionId}`;
                termSlot.after(container);
              }
            }
            if (container) {
              container.insertAdjacentHTML('beforeend', html);
              activateScripts(container);
            }
          }
        })
        .catch(() => showToast('Failed to spawn debug shell', 'error'));
    });
    menu.appendChild(shellItem);

    // Host shell — same worktree, host env, session-scoped az config
    const hostShellItem = document.createElement('button');
    hostShellItem.className = 'term-close-menu__item';
    hostShellItem.textContent = 'Host Shell';
    hostShellItem.addEventListener('click', () => {
      menu.remove();
      fetch(`/api/sessions/${sessionId}/host-shell`, { method: 'POST' })
        .then((r) => {
          if (r.ok) return r.text();
          throw new Error('Failed to spawn host shell');
        })
        .then((html) => {
          if (html) {
            let container = document.getElementById(`debug-shells-${sessionId}`);
            if (!container) {
              const termSlot = document.getElementById(`terminal-slot-${sessionId}`);
              if (termSlot) {
                container = document.createElement('div');
                container.id = `debug-shells-${sessionId}`;
                termSlot.after(container);
              }
            }
            if (container) {
              container.insertAdjacentHTML('beforeend', html);
              activateScripts(container);
            }
          }
        })
        .catch(() => showToast('Failed to spawn host shell', 'error'));
    });
    menu.appendChild(hostShellItem);

    // Az Sign In — session-scoped device code flow
    const azLoginItem = document.createElement('button');
    azLoginItem.className = 'term-close-menu__item';
    azLoginItem.textContent = 'Az Sign In';
    azLoginItem.addEventListener('click', () => {
      menu.remove();
      fetch(`/api/az-login/session/${sessionId}`, { method: 'POST' })
        .then((r) => {
          if (r.ok) return r.text();
          throw new Error('Failed to start az login');
        })
        .then((html) => {
          if (html) {
            let container = document.getElementById(`debug-shells-${sessionId}`);
            if (!container) {
              const termSlot = document.getElementById(`terminal-slot-${sessionId}`);
              if (termSlot) {
                container = document.createElement('div');
                container.id = `debug-shells-${sessionId}`;
                termSlot.after(container);
              }
            }
            if (container) {
              container.insertAdjacentHTML('beforeend', html);
              // Process htmx attributes (hx-get polling on the banner)
              htmx.process(container);
            }
          }
        })
        .catch(() => showToast('Failed to start az login', 'error'));
    });
    menu.appendChild(azLoginItem);
  }

  // Stop (SIGTERM) — only if session is running
  if (status === 'running') {
    const stopItem = document.createElement('button');
    stopItem.className = 'term-close-menu__item term-close-menu__item--warn';
    stopItem.textContent = 'Stop session';
    stopItem.addEventListener('click', () => {
      menu.remove();
      fetch(`/api/sessions/${sessionId}/stop`, { method: 'POST' })
        .then((r) => { if (r.ok) return r.text(); })
        .then((html) => {
          if (html) {
            const card = document.getElementById(`session-${sessionId}`);
            if (card) { card.outerHTML = html; }
          }
        })
        .catch(() => {});
    });
    menu.appendChild(stopItem);
  }

  // Reopen — only if session is failed, cancelled, or completed
  if (status === 'failed' || status === 'cancelled' || status === 'completed') {
    const reopenItem = document.createElement('button');
    reopenItem.className = 'term-close-menu__item term-close-menu__item--success';
    reopenItem.textContent = 'Reopen session';
    reopenItem.addEventListener('click', () => {
      menu.remove();
      fetch(`/api/sessions/${sessionId}/reopen`, { method: 'POST' })
        .then((r) => {
          if (r.ok && r.redirected) { window.location.href = r.url; }
          else if (r.ok) {
            const redirect = r.headers.get('HX-Redirect');
            if (redirect) window.location.href = redirect;
            else window.location.reload();
          }
        })
        .catch(() => {});
    });
    menu.appendChild(reopenItem);
  }

  // Fork (open new-session form pre-filled from this session)
  const forkItem = document.createElement('button');
  forkItem.className = 'term-close-menu__item';
  forkItem.textContent = 'Fork session';
  forkItem.addEventListener('click', () => {
    menu.remove();
    htmx.ajax('GET', `/api/sessions/${sessionId}/fork-form`, '#form-panel-slot');
    document.getElementById('form-panel').classList.add('is-open');
  });
  menu.appendChild(forkItem);

  // Delete (remove DB + worktree)
  const deleteItem = document.createElement('button');
  deleteItem.className = 'term-close-menu__item term-close-menu__item--danger';
  deleteItem.textContent = 'Delete session';
  deleteItem.addEventListener('click', () => {
    if (!confirm('Delete this session? This cannot be undone.')) {
      menu.remove();
      return;
    }
    menu.remove();
    fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' })
      .then((r) => {
        if (r.ok) {
          const card = document.getElementById(`session-${sessionId}`);
          if (card) card.remove();
        } else {
          r.text().then((body) => {
            alert(`Failed to delete session: ${r.status} ${body || r.statusText}`);
          });
        }
      })
      .catch((err) => {
        alert(`Failed to delete session: ${err.message}`);
      });
  });
  menu.appendChild(deleteItem);

  // Position the menu below the anchor button
  const actionsContainer = anchorBtn.closest('.terminal-header__actions') || anchorBtn.closest('.session-card__term-actions');
  actionsContainer.appendChild(menu);

  // Dismiss on click outside
  function dismiss(e) {
    if (!menu.contains(e.target) && e.target !== anchorBtn) {
      menu.remove();
      document.removeEventListener('pointerdown', dismiss, true);
    }
  }
  // Delay listener so the current click doesn't immediately dismiss
  requestAnimationFrame(() => {
    document.addEventListener('pointerdown', dismiss, true);
  });
}

/**
 * Activate <script> tags inside a container element.
 * Scripts injected via insertAdjacentHTML/innerHTML are inert — the browser
 * won't execute them. This function clones each script into a new element
 * so the browser treats it as freshly inserted and runs it.
 * @param {HTMLElement} container
 */
function activateScripts(container) {
  for (const old of container.querySelectorAll('script')) {
    const fresh = document.createElement('script');
    for (const attr of old.attributes) {
      fresh.setAttribute(attr.name, attr.value);
    }
    fresh.textContent = old.textContent;
    old.replaceWith(fresh);
  }
  // Process HTMX attributes on dynamically inserted content
  if (typeof htmx !== 'undefined') {
    htmx.process(container);
  }
}

/**
 * Toggle fullscreen for a debug/host shell panel.
 * @param {string} shellId
 */
function fullscreenShell(shellId) {
  const panel = document.getElementById(`debug-shell-${shellId}`);
  if (!panel) return;

  const isFs = panel.classList.contains('is-fullscreen');

  // Exit any other fullscreen first (session or shell)
  if (fullscreenId && fullscreenId !== shellId) {
    exitFullscreen(fullscreenId);
  }

  if (isFs) {
    panel.classList.remove('is-fullscreen');
    const grid = getSessionGrid();
    if (grid) grid.classList.remove('has-fullscreen-terminal');
    const card = getParentCard(panel);
    if (card) card.classList.remove('is-fullscreen-card');
    fullscreenId = null;

    const btn = panel.querySelector('.terminal-header__btn[title="Exit fullscreen"]');
    if (btn) {
      btn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="4 1 1 1 1 4" /><polyline points="12 1 15 1 15 4" />
        <polyline points="4 15 1 15 1 12" /><polyline points="12 15 15 15 15 12" />
      </svg>`;
      btn.title = 'Fullscreen';
    }
  } else {
    panel.classList.add('is-fullscreen');
    const grid = getSessionGrid();
    if (grid) grid.classList.add('has-fullscreen-terminal');
    const card = getParentCard(panel);
    if (card) card.classList.add('is-fullscreen-card');
    fullscreenId = shellId;

    const btn = panel.querySelector('.terminal-header__btn[title="Fullscreen"]');
    if (btn) {
      btn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="1 4 4 4 4 1" /><polyline points="15 4 12 4 12 1" />
        <polyline points="1 12 4 12 4 15" /><polyline points="15 12 12 12 12 15" />
      </svg>`;
      btn.title = 'Exit fullscreen';
    }
  }

  refitTerminal(shellId);
}

// Global bindings for template onclick handlers
window.__termFullscreen = fullscreenTerminal;
window.__termClose = removeTerminal;
window.__termCloseMenu = showCloseMenu;
window.__shellFullscreen = fullscreenShell;
window.__termVoice = toggleVoice;

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
    const grid = getSessionGrid();
    if (grid) grid.classList.add('has-fullscreen-terminal');
    const card = getParentCard(panel);
    if (card) card.classList.add('is-fullscreen-card');
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
  const panel = document.getElementById(`terminal-panel-${sessionId}`)
    || document.getElementById(`debug-shell-${sessionId}`);
  if (!panel) return;

  panel.classList.remove('is-fullscreen');
  const grid = getSessionGrid();
  if (grid) grid.classList.remove('has-fullscreen-terminal');
  const card = getParentCard(panel);
  if (card) card.classList.remove('is-fullscreen-card');
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
 * @param {string} [wsPrefix='/ws/terminal/'] - WebSocket path prefix.
 */
export async function openTerminal(sessionId, containerId, wsPrefix = '/ws/terminal/') {
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

  // Make URLs in terminal output clickable
  if (window.WebLinksAddon?.WebLinksAddon) {
    term.loadAddon(new window.WebLinksAddon.WebLinksAddon());
  }

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
    ? `${proto}//${location.host}${wsPrefix}${sessionId}?ticket=${ticket}`
    : `${proto}//${location.host}${wsPrefix}${sessionId}`;
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

  // Stop voice recognition if active for this terminal
  if (voiceState && voiceState.sessionId === sessionId) {
    voiceState.recognition.stop();
  }

  const { term, ws, observer } = entry;
  ws.close();
  term.dispose();
  observer.disconnect();
  openTerminals.delete(sessionId);
}
