# Phase 5: Phase 5 – Mobile UI: Single-Terminal Page
**Milestones: 6**

Deliver the mobile-optimised /mobile page as a separate HTMX template targeting phone browsers. Single active terminal at a time, touch-friendly controls, same auth as desktop. Separate from desktop to keep both simple rather than trying to make one responsive layout do everything.

## Milestone 1: Mobile HTML shell: bottom-tab navigation, full-viewport terminal area, touch-friendly button sizing
Establish the static HTML skeleton for the mobile page with bottom-tab navigation, a full-viewport terminal container placeholder, and the Express route that serves it — styled with the Hive blue accent palette and proper mobile viewport meta tags.

1. Create `src/web/templates/mobile.html` as a full HTML document with `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`, `<meta name="apple-mobile-web-app-capable" content="yes">`, and `<meta name="theme-color" content="#1a1f2e">` in the `<head>`.
2. Inside `mobile.html` add a `<div id="mobile-shell">` root element containing three child regions: `<div id="mobile-header">` (shows app name and connection badge placeholder), `<div id="mobile-terminal-area">` (stretches to fill remaining viewport height using CSS flex), and `<nav id="mobile-tabs">` (fixed to bottom with four tab buttons: Sessions, Terminal, Send, Info).
3. Inside `<nav id="mobile-tabs">` define four `<button class="tab-btn">` elements each with a data-tab attribute (`sessions`, `terminal`, `send`, `info`), an SVG icon inline, and a text label, each with `min-height: 56px` applied via the CSS class.
4. Create `src/web/public/mobile.css` and define: `:root` with `--accent: #2563eb`, `--bg: #0f1117`, `--surface: #1a1f2e`, `--text: #e2e8f0`, `--border: #2d3748`; `body` with `margin:0; background: var(--bg); color: var(--text); font-family: system-ui, sans-serif; height: 100dvh; display: flex; flex-direction: column; overflow: hidden`; `#mobile-shell` with `display:flex; flex-direction:column; height:100dvh`; `#mobile-header` with `height:48px; background:var(--surface); display:flex; align-items:center; padding: 0 16px; flex-shrink:0`; `#mobile-terminal-area` with `flex:1; min-height:0; position:relative; overflow:hidden`; `#mobile-tabs` with `height:56px; background:var(--surface); border-top:1px solid var(--border); display:flex; flex-shrink:0; padding-bottom: env(safe-area-inset-bottom)`; `.tab-btn` with `flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; border:none; background:transparent; color:var(--text); font-size:10px; cursor:pointer; min-height:44px; -webkit-tap-highlight-color:transparent`; `.tab-btn.active` with `color:var(--accent)`.
5. Create `src/web/routes/mobile.ts` exporting an Express `Router`. Add a `GET /` handler that reads `src/web/templates/mobile.html` from disk using `fs.readFileSync`, injects a CSRF nonce and the auth user display name into the template via simple string replacement of `{{nonce}}` and `{{user}}` placeholders, then sends the result with `Content-Type: text/html`.
6. Open `src/web/server.ts` and import the new router: `import mobileRouter from './routes/mobile.js'`. Mount it at `/mobile` after the auth middleware with `app.use('/mobile', requireAuth, mobileRouter)` so the same session guard used for the desktop dashboard applies.
7. Add `<link rel="stylesheet" href="/public/mobile.css">` and `<script src="/public/htmx.min.js" defer></script>` to the `<head>` of `mobile.html`.

**Key files**: src/web/templates/mobile.html, src/web/routes/mobile.ts, src/web/public/mobile.css, src/web/server.ts

**Verification**:
```bash
npm run build && curl -s http://localhost:3000/mobile | grep 'mobile-shell' && npx tsc --noEmit
```

## Milestone 2: Session selector: HTMX-swapped list of active sessions, tap to connect terminal
Implement the Sessions tab content as an HTMX-fetched partial that lists all active sessions; tapping a session entry stores it as the active session and swaps the terminal area — wiring together the session data layer from Phase 2 with the mobile shell.

1. Create `src/web/templates/mobile-sessions-list.html` as an HTML fragment (no `<html>` wrapper) containing a `<div id="sessions-panel" class="panel">` with a heading `<h2 class="panel-title">Active Sessions</h2>` and a `<ul id="session-list" class="session-list">` that will be populated server-side.
2. Create `src/web/templates/mobile-session-item.html` as a fragment containing a `<li class="session-item" data-session-id="{{sessionId}}">` element. Inside it place a `<button class="session-select-btn" hx-post="/mobile/connect/{{sessionId}}" hx-target="#mobile-terminal-area" hx-swap="innerHTML" hx-on::after-request="window._mobileSetActiveTab('terminal')">` button showing `{{sessionName}}`, `{{sessionStatus}}` badge, and `{{worktreeBranch}}` subtitle. The button must have `min-height:44px` via class `.session-select-btn`.
3. Open `src/web/routes/mobile.ts` and add a `GET /sessions` handler. Inside it call `sessionRepository.listActive()` (the repository from Phase 1/2), map each session to a rendered `mobile-session-item.html` fragment by replacing `{{sessionId}}`, `{{sessionName}}`, `{{sessionStatus}}`, and `{{worktreeBranch}}` placeholders, join the items, inject them into the `<ul>` in `mobile-sessions-list.html`, and send the resulting HTML fragment with `Content-Type: text/html`.
4. In `src/web/templates/mobile.html`, update the Sessions tab button to include `hx-get="/mobile/sessions"`, `hx-target="#mobile-terminal-area"`, `hx-swap="innerHTML"`, and `hx-trigger="click"` so that tapping the Sessions tab fetches the list into the terminal area.
5. Add a `POST /connect/:sessionId` handler to `src/web/routes/mobile.ts`. It must validate that `:sessionId` exists in the session repository, store `req.session.mobileActiveSessionId = sessionId` (using the Express session from Phase 3), then return a minimal HTML fragment `<div id="terminal-connecting" class="connecting-msg">Connecting…</div>` with an `HX-Trigger: mobileSessionConnected` response header so the client-side xterm.js initialisation (added in the next milestone) can react.
6. Add CSS to `src/web/public/mobile.css` for `.session-list` (`list-style:none; margin:0; padding:8px`), `.session-item` (`border-bottom:1px solid var(--border)`), `.session-select-btn` (`width:100%; text-align:left; background:transparent; border:none; color:var(--text); padding:12px 16px; min-height:44px; cursor:pointer; display:flex; flex-direction:column; gap:4px`), `.session-select-btn:active` (`background: rgba(37,99,235,0.15)`), and `.session-status-badge` with colours conditional on a `data-status` attribute using CSS attribute selectors (`[data-status="running"]{ color:#22c55e }`, `[data-status="idle"]{ color:#94a3b8 }`, `[data-status="error"]{ color:#ef4444 }`).
7. Add an `hx-on::after-settle` attribute on `<div id="mobile-terminal-area">` in `mobile.html` that calls `window._mobileAfterSwap()` — a stub function defined in an inline `<script>` block — so later milestones can hook into content swaps without modifying the template again.

**Key files**: src/web/routes/mobile.ts, src/web/templates/mobile-sessions-list.html, src/web/templates/mobile-session-item.html, src/web/public/mobile.css

**Verification**:
```bash
npm run build && npx tsc --noEmit && curl -s -H 'Accept: text/html' http://localhost:3000/mobile/sessions | grep 'session-item'
```

## Milestone 3: Full-screen xterm.js terminal with on-screen keyboard send button and swipe-to-disconnect
Mount an xterm.js instance inside the mobile terminal area that connects via WebSocket to the active session's PTY stream, fills the available viewport, and disconnects when the user swipes down — reusing the Phase 3 WebSocket PTY infrastructure.

1. Create `src/web/templates/mobile-terminal-frame.html` as an HTML fragment containing `<div id="terminal-frame" class="terminal-frame"><div id="xterm-container" class="xterm-container"></div><div id="swipe-hint" class="swipe-hint">Swipe down to disconnect</div></div>`. Include `data-session-id="{{sessionId}}"` and `data-ws-url="{{wsUrl}}"` attributes on `#terminal-frame` so the JS can read connection parameters without hardcoding them.
2. Add a `GET /terminal/:sessionId` handler to `src/web/routes/mobile.ts`. Validate that `:sessionId` matches `req.session.mobileActiveSessionId` (preventing session-hopping). Render `mobile-terminal-frame.html` replacing `{{sessionId}}` with the validated ID and `{{wsUrl}}` with `wss://${req.hostname}/ws/pty/${sessionId}`. Return the fragment as `text/html`.
3. Create `src/web/public/mobile-terminal.js` as a plain ES module (not TypeScript; loaded via `<script type="module">` in the shell). At the top import xterm and FitAddon from the CDN-relative paths already used by the desktop page: `import { Terminal } from '/public/xterm/xterm.esm.js'` and `import { FitAddon } from '/public/xterm/addon-fit.esm.js'`.
4. In `mobile-terminal.js` define and export `function initMobileTerminal(containerId, wsUrl)`. Inside: (a) construct `new Terminal({ theme: { background: '#0f1117', foreground: '#e2e8f0', cursor: '#2563eb' }, fontSize: 13, fontFamily: 'Menlo, monospace', scrollback: 500 })`; (b) construct `new FitAddon()` and call `term.loadAddon(fitAddon)`; (c) call `term.open(document.getElementById(containerId))`; (d) call `fitAddon.fit()`; (e) open `new WebSocket(wsUrl)`, set `ws.binaryType = 'arraybuffer'`; (f) in `ws.onmessage` decode `ArrayBuffer` via `new TextDecoder().decode(event.data)` and call `term.write(data)`; (g) wire `term.onData(data => ws.send(data))` so keyboard input flows back to the PTY; (h) attach a `ResizeObserver` on the container element that calls `fitAddon.fit()` then sends a JSON resize message `{ type:'resize', cols:term.cols, rows:term.rows }` over the WebSocket.
5. In `mobile-terminal.js` implement `function initSwipeToDisconnect(frameEl, onDisconnect)`. Use `touchstart` and `touchend` listeners on `frameEl`. Track `startY` on touchstart; on touchend if `endY - startY > 80` (downward swipe of 80px) call `onDisconnect()`. Inside `onDisconnect`: call `ws.close()`, call `term.dispose()`, and use `htmx.ajax('GET', '/mobile/sessions', '#mobile-terminal-area')` to swap back to the session list.
6. In `mobile-terminal.js` add a top-level `document.addEventListener('htmx:afterSwap', (e) => { const frame = e.target.querySelector('#terminal-frame'); if (!frame) return; initMobileTerminal('xterm-container', frame.dataset.wsUrl); initSwipeToDisconnect(frame, disconnect); })` so the terminal boots automatically after every HTMX swap that contains `#terminal-frame`.
7. Add `<script type="module" src="/public/mobile-terminal.js"></script>` to the `<head>` of `src/web/templates/mobile.html`.
8. Add CSS to `src/web/public/mobile.css`: `.terminal-frame` with `position:relative; height:100%; display:flex; flex-direction:column`; `.xterm-container` with `flex:1; min-height:0; overflow:hidden`; `.swipe-hint` with `position:absolute; bottom:8px; left:50%; transform:translateX(-50%); font-size:11px; color:rgba(148,163,184,0.5); pointer-events:none; user-select:none`; and override `.xterm-viewport` with `overflow-y: auto !important` to enable terminal scroll on touch.
9. In the Phase 3 WebSocket handler (located in `src/web/server.ts` or equivalent `src/web/routes/ws.ts`), confirm that the PTY resize message handler already checks for `{ type:'resize', cols, rows }` and calls `ptyProcess.resize(cols, rows)` — add this branch if missing.

**Key files**: src/web/public/mobile-terminal.js, src/web/templates/mobile-terminal-frame.html, src/web/routes/mobile.ts, src/web/public/mobile.css

**Verification**:
```bash
npm run build && npx tsc --noEmit && node -e "const fs=require('fs'); const s=fs.readFileSync('src/web/public/mobile-terminal.js','utf8'); if(!s.includes('FitAddon')) process.exit(1); console.log('ok')"
```

## Milestone 4: Mobile-specific CSS: safe-area insets, no-hover styles, 44px minimum touch targets
Harden the mobile stylesheet so all interactive elements meet Apple/Google 44px minimum touch target guidelines, hover states never fire on touch devices, and the layout respects iOS notch and Android navigation bar safe areas throughout.

1. Open `src/web/public/mobile.css` and update the `#mobile-tabs` rule to use `padding-bottom: max(env(safe-area-inset-bottom), 8px)` so the bottom nav is pushed above the iOS home indicator and Android gesture bar on all devices.
2. Add `padding-top: env(safe-area-inset-top)` to `#mobile-header` so the header does not sit behind a dynamic island or status bar on edge-to-edge displays.
3. Add `padding-left: env(safe-area-inset-left); padding-right: env(safe-area-inset-right)` to `#mobile-terminal-area` so the xterm canvas does not render content under rounded screen corners in landscape orientation.
4. Audit every interactive element class (`.tab-btn`, `.session-select-btn`, `.send-btn`, `.disconnect-btn`) and ensure each has `min-height: 44px` and `min-width: 44px` where applicable. For icon-only buttons add `padding: 10px` as a fallback so the tap area expands even if the icon is smaller.
5. Wrap all `:hover` rules (`.tab-btn:hover`, `.session-select-btn:hover`, `.send-btn:hover`) inside `@media (hover: hover) { … }` blocks so they only apply on devices that have a true pointer hover — this prevents iOS from applying and sticking the hover style on first tap.
6. Add `:active` pseudo-class rules for each interactive element outside the hover media query: `.tab-btn:active`, `.session-select-btn:active`, and `.send-btn:active` should each show `background: rgba(37,99,235,0.2)` as a visible tap feedback.
7. Add `touch-action: manipulation` to `.tab-btn`, `.session-select-btn`, and `.send-btn` to eliminate the 300ms double-tap delay on browsers that do not yet apply it automatically.
8. Add `-webkit-overflow-scrolling: touch` and `overscroll-behavior: contain` to `.session-list` so the session list scrolls natively on iOS and does not bubble scroll to the page body.
9. Add `user-select: none; -webkit-user-select: none` to `.tab-btn` and `.mobile-header` so long-press does not trigger text selection on those structural elements.
10. Add a `@media (orientation: landscape)` block that reduces `#mobile-tabs` height to `44px` and `#mobile-header` height to `36px`, and increases `xterm` `fontSize` via a CSS custom property `--term-font-size: 11px` (the JS reads this via `getComputedStyle` if needed) to make better use of the wider but shorter viewport in landscape.

**Key files**: src/web/public/mobile.css

**Verification**:
```bash
node -e "const s=require('fs').readFileSync('src/web/public/mobile.css','utf8'); ['env(safe-area-inset','min-height:44px','@media(hover:hover)','touch-action'].forEach(t=>{if(!s.includes(t)){console.error('missing:',t);process.exit(1)}}); console.log('CSS audit passed')"
```

## Milestone 5: Send-message modal: tap-to-open overlay with text input for injecting commands into the active session
Implement the Send tab as a modal overlay containing a text input and a Send button that POSTs the typed text to the active session's PTY input endpoint, giving the operator a reliable way to inject commands without relying on the on-screen keyboard directly interacting with xterm.js.

1. Create `src/web/templates/mobile-send-modal.html` as an HTML fragment. The root element is `<div id="send-modal" class="send-modal" role="dialog" aria-modal="true" aria-label="Send command">`. Inside place: a `<div class="send-modal-backdrop">` (full-screen semi-transparent overlay, closes modal on tap), a `<div class="send-modal-sheet">` (bottom-anchored sheet panel), containing `<label class="send-label" for="send-input">Send to terminal</label>`, `<textarea id="send-input" class="send-input" rows="3" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="Type command…"></textarea>`, `<div class="send-modal-actions">` with two buttons: `<button class="send-cancel-btn" type="button">Cancel</button>` and `<button class="send-submit-btn" hx-post="/mobile/send" hx-include="#send-input" hx-target="#send-result" hx-swap="innerHTML" type="button">Send ↵</button>`, and `<div id="send-result" class="send-result"></div>`.
2. Add a `POST /send` handler to `src/web/routes/mobile.ts`. Read `req.session.mobileActiveSessionId`; if absent return `401` with fragment `<span class="error">No active session</span>`. Read `req.body.text` (Express JSON or urlencoded body parser must already be configured from Phase 3). Validate that `text` is a non-empty string of at most 4096 characters. Look up the active PTY process from the `PtyManager` (from Phase 2) using the session ID, call `ptyProcess.write(text)`, and respond with `<span class="success">Sent</span>` as `text/html`. On any error respond with `<span class="error">Failed: ${escapeHtml(err.message)}</span>`.
3. In `src/web/public/mobile-terminal.js` add function `openSendModal()` that uses `htmx.ajax('GET', '/mobile/send-modal', { target: '#mobile-shell', swap: 'beforeend' })` to append the modal fragment to the shell, then immediately focuses `#send-input` via `document.getElementById('send-input').focus()`.
4. Add a `GET /send-modal` handler to `src/web/routes/mobile.ts` that simply returns the rendered `mobile-send-modal.html` fragment as `text/html` — no dynamic substitution needed.
5. In `src/web/templates/mobile.html` update the Send tab button: replace its `hx-get` with `onclick="openSendModal()"` and remove any `hx-target` attribute so it does not trigger an HTMX swap directly.
6. In `mobile-terminal.js` add a `document.addEventListener('htmx:afterSwap', ...)` handler specifically for the send modal: after a swap, if `#send-modal` exists in the DOM, attach a click listener to `.send-modal-backdrop` and `.send-cancel-btn` that both call `document.getElementById('send-modal').remove()`, and attach a `keydown` listener on `#send-input` that on `Enter` (without Shift) programmatically clicks `.send-submit-btn`.
7. In `mobile-terminal.js` add an `htmx:afterRequest` listener: when the POST to `/mobile/send` completes successfully (response contains `.success`), call `setTimeout(() => document.getElementById('send-modal').remove(), 600)` so the modal auto-dismisses after the user sees the confirmation.
8. Add CSS to `src/web/public/mobile.css`: `.send-modal` with `position:fixed; inset:0; z-index:100; display:flex; flex-direction:column; justify-content:flex-end`; `.send-modal-backdrop` with `position:absolute; inset:0; background:rgba(0,0,0,0.6); cursor:pointer`; `.send-modal-sheet` with `position:relative; background:var(--surface); border-radius:16px 16px 0 0; padding:16px 16px max(env(safe-area-inset-bottom),16px); display:flex; flex-direction:column; gap:12px`; `.send-input` with `width:100%; background:var(--bg); color:var(--text); border:1px solid var(--border); border-radius:8px; padding:10px; font-size:16px; resize:none; box-sizing:border-box` (font-size 16px prevents iOS auto-zoom); `.send-submit-btn` with `background:var(--accent); color:#fff; border:none; border-radius:8px; padding:12px; min-height:44px; font-size:16px; cursor:pointer; font-weight:600`; `.send-cancel-btn` with `background:transparent; border:1px solid var(--border); color:var(--text); border-radius:8px; padding:12px; min-height:44px; cursor:pointer`.

**Key files**: src/web/templates/mobile-send-modal.html, src/web/routes/mobile.ts, src/web/public/mobile.css, src/web/public/mobile-terminal.js

**Verification**:
```bash
npm run build && npx tsc --noEmit && curl -s -X POST http://localhost:3000/mobile/send -H 'Content-Type: application/json' -d '{"text":"ls\n"}' | grep -E '(ok|error|unauthorized)'
```

## Milestone 6: Connection status indicator: SSE-driven badge showing live/reconnecting/disconnected
Add a real-time connection status badge in the mobile header that reflects the WebSocket PTY connection state using a Server-Sent Events stream for server-push updates, giving the operator immediate visibility when a session drops or reconnects.

1. Open `src/web/templates/mobile.html` and replace the connection badge placeholder in `#mobile-header` with `<span id="conn-badge" class="conn-badge conn-disconnected" aria-live="polite" aria-label="Connection status">●&nbsp;Disconnected</span>`. Also add `<div hx-ext="sse" sse-connect="/mobile/status-stream" sse-swap="connStatus" hx-target="#conn-badge" hx-swap="outerHTML"></div>` immediately before the closing `</body>` tag so HTMX SSE extension auto-connects on page load.
2. Add a `GET /status-stream` handler to `src/web/routes/mobile.ts`. Set response headers `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, and `X-Accel-Buffering: no`. Every 5 seconds (using `setInterval`) read `req.session.mobileActiveSessionId`, look it up in the `PtyManager` to check if the process is still alive (`ptyManager.isAlive(sessionId)`), and write either `event: connStatus
data: <span id="conn-badge" class="conn-badge conn-live" aria-live="polite">●&nbsp;Live</span>

` or the disconnected variant. On `req.on('close', ...)` clear the interval and end the response.
3. In `src/web/public/mobile-terminal.js` update `initMobileTerminal` to update the badge directly on WebSocket state changes: in `ws.onopen` call `updateBadge('live')`, in `ws.onclose` call `updateBadge('reconnecting')` and attempt reconnect after 3000ms (max 3 retries), on reconnect failure call `updateBadge('disconnected')`.
4. Define `function updateBadge(state)` in `mobile-terminal.js` that finds `document.getElementById('conn-badge')`, sets its `className` to `conn-badge conn-${state}`, and sets its `textContent` to one of `● Live`, `◌ Reconnecting…`, or `● Disconnected` based on `state`.
5. Implement the WebSocket reconnect logic in `mobile-terminal.js`: extract the terminal setup into `function connectWs(wsUrl, term, fitAddon, retryCount)`. On `ws.onclose`, if `retryCount < 3` call `setTimeout(() => connectWs(wsUrl, term, fitAddon, retryCount + 1), 3000 * (retryCount + 1))` for exponential back-off. After 3 failures call `updateBadge('disconnected')` and show a `<div class="reconnect-failed-msg">Session disconnected. <button onclick="location.reload()">Reload</button></div>` by appending it to `#terminal-frame`.
6. Add CSS to `src/web/public/mobile.css`: `.conn-badge` with `font-size:11px; padding:2px 8px; border-radius:10px; font-weight:600; transition:background 0.3s`; `.conn-live` with `background:rgba(34,197,94,0.2); color:#22c55e`; `.conn-reconnecting` with `background:rgba(234,179,8,0.2); color:#eab308`; `.conn-disconnected` with `background:rgba(239,68,68,0.2); color:#ef4444`.
7. Ensure the HTMX SSE extension script (`htmx-ext-sse.js`) is included in `mobile.html` `<head>` after `htmx.min.js`: `<script src="/public/htmx-ext-sse.js" defer></script>`. Confirm the file exists in `src/web/public/` — if not, copy it from the desktop page's public assets (it should already be present from Phase 4).
8. Add an integration smoke-test script `src/web/__tests__/mobile-sse.test.ts` using the Phase 1/2 test harness pattern: spawn the server, create a session, open an EventSource to `/mobile/status-stream` with a mocked authenticated session cookie, assert that within 8 seconds at least one `connStatus` SSE event is received with data containing `conn-live`.

**Key files**: src/web/routes/mobile.ts, src/web/public/mobile-terminal.js, src/web/templates/mobile.html, src/web/public/mobile.css

**Verification**:
```bash
npm run build && npx tsc --noEmit && curl -s -N -H 'Accept: text/event-stream' http://localhost:3000/mobile/status-stream | head -5 | grep 'data:'
```

---