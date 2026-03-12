# Validate MCP: Interactive Browser Handoff

## Problem

PCF controls run inside Power Apps on Dataverse. To validate a control works with real data, the agent needs an authenticated browser session against `https://org.crm4.dynamics.com`. Microsoft login requires interactive MFA — it can't be automated. The agent needs to hand the browser to a human for login, then take it back for visual verification.

## Solution

Add a `validate_handoff` MCP tool that pauses agent control, exposes the Playwright browser to the user via CDP screencast, lets the user interact (login, MFA), then returns control to the agent. After handoff, the user can continue watching in spectator mode.

## How pcf-dev-proxy fits in

[pcf-dev-proxy](https://github.com/Kristoffer88/pcf-dev-proxy) is an HTTPS MITM proxy that intercepts PCF bundle requests and serves local builds. It normally launches its own Chrome, but for this flow it needs a `--no-browser` flag to run as proxy-only. Playwright routes traffic through it so the MITM interception works with the agent's browser.

## The Flow

### Setup (once per repo)

Orcha repo validation config:

```
validateMode:  "serve"
validateStart: "npx pcf-dev-proxy --no-browser --port 8642"
validateHealth: "/health"
```

### During a session

```
1. Agent builds the PCF control (pcf-start, npm run build, etc.)

2. Agent calls validate_start
   → Orcha starts pcf-dev-proxy in proxy-only mode
   → Polls /health until ready

3. Agent calls validate_handoff({
     url: "https://org.crm4.dynamics.com/main.aspx?appid=...&etn=account&id=...",
     message: "Please log in to Dataverse so I can verify the control",
     proxy: "http://localhost:8642",
     wait_for: "#customControl_cc_Contoso_MyControl"
   })
   → Playwright launches Chromium with proxy settings pointing at pcf-dev-proxy
   → Navigates to the Dataverse URL → Microsoft redirects to login
   → Orcha starts CDP screencast (JPEG frames over websocket)
   → Orcha pushes SSE event to UI: "Browser handoff requested"
   → MCP tool call BLOCKS — agent is suspended

4. User sees notification in Orcha UI
   → Clicks to open browser viewer
   → Live canvas showing the Microsoft login page

5. User logs in
   → Mouse clicks and keystrokes captured on canvas
   → Forwarded via CDP Input.dispatch* events to Chromium
   → User handles MFA on phone, consents, etc.
   → Microsoft redirects back to Dataverse
   → pcf-dev-proxy intercepts bundle.js request, serves local build
   → PCF control renders with real data

6. Handoff completes (one of):
   → wait_for selector appears in DOM → auto-detected
   → User clicks "Done" button manually

7. MCP tool returns to agent with:
   → Final screenshot of the authenticated page
   → Page title and current URL

8. Viewer switches to spectator mode
   → User can still watch the live browser stream
   → Input forwarding disabled — watch only

9. Agent validates
   → validate_browse, validate_screenshot, validate_extract as usual
   → Browser is authenticated, proxy is intercepting
   → Agent inspects the rendered PCF control with real data
   → User watches live via spectator stream

10. Agent calls validate_stop
    → Proxy shuts down, browser closes, cookies destroyed
```

### Short version

```
Agent builds → starts proxy → opens Dataverse URL →
User logs in via live stream → clicks Done →
Agent takes over authenticated browser → screenshots and verifies →
User watches live → done
```

## Technical Approach: CDP Screencast

Playwright's Chromium exposes the Chrome DevTools Protocol. We use two CDP features:

- **`Page.startScreencast`** — streams JPEG frames of the browser viewport over a websocket. ~10fps, quality 60, 1280x720.
- **`Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`** — forwards user mouse/keyboard input to the browser.

Orcha acts as a **filtered CDP relay** — it only forwards screencast frames and input events, not arbitrary CDP commands. This is important for security.

### Why CDP over alternatives

| Approach | Pros | Cons |
|---|---|---|
| **CDP screencast** | Zero deps (Playwright already uses CDP), lightweight, Orcha owns the UX | Need to build the canvas viewer + input translation |
| **noVNC (Xvfb + x11vnc)** | Battle-tested remote desktop | Heavy deps, Xvfb in container, more attack surface |
| **Raw CDP websocket** | Zero Orcha code | No filtering, full browser control exposed, terrible UX |

CDP screencast is the lightest path — no new container dependencies, stays within what Playwright already provides.

## Implementation Plan

### Phase 1: BrowserManager Handoff State (foundation)

**File:** `src/validation/browser-manager.ts`

Everything else depends on this.

- Add handoff state to `BrowserSession`:
  ```
  idle → handoff_active → spectating → idle
  ```
- `startHandoff(sessionId, url, opts)` — navigates Playwright, creates CDP session via `page.context().newCDPSession(page)`, starts `Page.startScreencast`, returns a Promise that blocks until completion
- `completeHandoff(sessionId)` — stops screencast, resolves the blocking promise, takes final screenshot. Must be **idempotent** (wait_for and Done button can fire simultaneously)
- `getCdpSession(sessionId)` — for the websocket relay
- `getHandoffState(sessionId)` — for status checks
- Block `browse()` / `screenshot()` during active handoff with clear error
- New `_navigateForHandoff()` that bypasses the origin restriction (Microsoft login is on different domains)

**Proxy support:** Accept optional `proxy` config on session creation. Playwright sets proxy at context level: `browser.newContext({ proxy: { server: '...' } })`. If proxy config changes, recreate the context.

### Phase 2: `validate_handoff` MCP Tool

**File:** `src/mcp/validate-mcp.ts`

New tool registration in `buildMcpServer`:

| Param | Type | Description |
|---|---|---|
| `url` | `string` | URL to navigate to before handoff |
| `message` | `string?` | Shown to user in Orcha UI |
| `proxy` | `string?` | HTTP proxy URL (e.g. `http://localhost:8642` for pcf-dev-proxy) |
| `wait_for` | `string?` | CSS selector — auto-completes handoff when it appears |
| `timeout` | `number?` | Max seconds to wait (default 300) |

The handler:

1. Looks up the validation env (requires prior `validate_start`)
2. Calls `browserManager.startHandoff()`
3. Emits SSE event to Orcha UI
4. **Blocks** on the returned Promise
5. Returns final screenshot + page title + URL

### Phase 3: CDP WebSocket Relay

**New file:** `src/web/ws/cdp-relay.ts`

Bridges browser viewer UI ↔ Playwright's CDP session. NOT a raw CDP proxy — a filtered relay.

**Client → server messages:**
```json
{ "type": "mouse", "params": { "type": "mousePressed", "x": 100, "y": 200, "button": "left", ... } }
{ "type": "key", "params": { "type": "keyDown", "key": "a", "code": "KeyA", ... } }
{ "type": "done" }
```

**Server → client messages:**
- Binary websocket frames: 8-byte header (width u32 + height u32) + JPEG bytes
- JSON status messages: `{ "type": "status", "mode": "interactive" | "spectate" }`

Responsibilities:

- Forward `Page.screencastFrame` events to client as binary frames
- Send `Page.screencastFrameAck` back to CDP for each frame
- In interactive mode: forward `Input.dispatch*` from client to CDP
- In spectate mode: drop all input messages
- Throttle to ~10fps server-side

### Phase 4: WebSocket Routing

**File:** `src/web/ws/ws-server.ts`

- New path: `/ws/cdp/:sessionId?mode=interactive|spectate`
- Auth check (same as terminal websocket — ticket-based)
- Route to `handleCdpRelay` from Phase 3
- Expose `browserManager` from `ValidationManager` via getter

### Phase 5: SSE Handoff Notification

**Files:** `src/web/services/event-bus.ts` + `src/web/routes/events.ts`

New event type:
```typescript
{ type: 'handoff', sessionId: string, status: 'started' | 'completed', url?: string, message?: string }
```

Session card listens via `sse-swap="handoff-{sessionId}"` and renders a banner/button when handoff starts. Banner disappears (or changes to "Spectating") on completion.

### Phase 6: Handoff Completion Endpoint

**File:** `src/web/routes/api.ts`

```
POST /api/sessions/:sessionId/handoff-complete
```

- Calls `validationManager.getBrowserManager().completeHandoff(sessionId)`
- Publishes SSE event
- Returns 200

Belt and suspenders with the websocket `done` message — either path completes the handoff.

### Phase 7: Browser Viewer UI

**New files:**
- `src/web/public/js/browser-viewer.js` — client-side JavaScript
- `src/web/views/partials/browser-viewer.html` — ETA partial template

No framework — vanilla JS, consistent with the codebase.

The viewer:
- Opens websocket to `/ws/cdp/:sessionId?mode=interactive&ticket=...`
- Renders JPEG frames on a `<canvas>` element
- Captures mouse events on canvas → translates to CDP coordinates (accounting for canvas scaling vs screencast frame dimensions)
- Captures keyboard events → translates to `Input.dispatchKeyEvent` params
- Shows the agent's `message` ("Please log in to Dataverse")
- "Done" button (hidden in spectate mode) → POSTs to completion endpoint
- Mode indicator: "Interactive" / "Spectating"
- Connection status indicator

**Session card addition** (`src/web/views/partials/session-card.html`):
- Handoff slot that listens for SSE events
- Renders a clickable banner that opens the browser viewer modal

### Phase 8: pcf-dev-proxy Changes

**Repo:** `Kristoffer88/pcf-dev-proxy`

Add `--no-browser` flag:
- Skip Chrome launch logic
- Run MITM proxy only
- Still auto-detect control from `ControlManifest.Input.xml`
- Still serve local builds from `out/controls/`
- Health endpoint still works

This is a small change — the proxy and browser launch are already separate concerns in the codebase.

## Dependency Graph

```
Phase 1 (BrowserManager)     ← everything depends on this
  ├── Phase 2 (MCP tool)
  ├── Phase 3 (CDP relay) ──→ Phase 4 (WS routing)
  ├── Phase 5 (SSE events)
  ├── Phase 6 (Completion endpoint)
  └── Phase 8 (pcf-dev-proxy)
                ↓
      Phase 7 (Browser viewer UI)    ← needs 4, 5, 6
```

Phases 2, 3, 5, 6, 8 are parallelizable after Phase 1.

## Files Summary

### New files
- `src/web/ws/cdp-relay.ts` — CDP websocket relay
- `src/web/public/js/browser-viewer.js` — client-side browser viewer
- `src/web/views/partials/browser-viewer.html` — viewer modal template

### Modified files
- `src/validation/browser-manager.ts` — handoff state, CDP session, proxy support
- `src/validation/validation-manager.ts` — expose browserManager, handoff delegation
- `src/mcp/validate-mcp.ts` — new `validate_handoff` tool
- `src/web/ws/ws-server.ts` — CDP relay websocket routing
- `src/web/services/event-bus.ts` — handoff event type
- `src/web/routes/events.ts` — handoff SSE rendering
- `src/web/routes/api.ts` — handoff completion endpoint
- `src/web/views/partials/session-card.html` — handoff notification slot

## Security Considerations

### Real risks

**CDP relay is a full browser remote control during handoff.**
During interactive mode, the websocket accepts mouse/keyboard input into a browser that's about to have Dataverse credentials. If the websocket connection is hijacked, an attacker can type into the login form.

*Mitigation:* The relay is behind Orcha's auth middleware — same ticket-based auth as terminal websockets. But anyone with Orcha access can interact with any active handoff. If Orcha ever goes multi-user, per-session authorization would be needed.

**`validate_handoff` bypasses the URL origin restriction.**
Today `validate_browse` only allows navigation to `localhost:{validationPort}`. Handoff intentionally removes this so it can navigate to `login.microsoftonline.com`, `org.crm4.dynamics.com`, etc. A rogue prompt could point the browser anywhere.

*Mitigation:* The human gatekeeps every handoff — they see the URL, they choose whether to log in. The agent is blocked and can't interact until the human completes the handoff.

**Dataverse session cookies live in the container.**
After login, authenticated cookies persist in Playwright's browser context until `validate_stop` kills the browser. If the container is compromised, those cookies are accessible.

*Mitigation:* Cookies die when the validation env stops — better than pcf-dev-proxy locally where `~/.pcf-dev-proxy/chrome-profile` persists cookies across restarts forever.

**Screencast frames contain sensitive data.**
The JPEG stream shows login forms, business data, customer records. It flows over websocket through Orcha's HTTP server.

*Mitigation:* In production, Orcha is behind Caddy (HTTPS), so the websocket is `wss://` — encrypted in transit. Frames are not persisted anywhere, they're fire-and-forget. Agent screenshots via `validate_screenshot` do go into MCP responses, same as today.

**pcf-dev-proxy MITM sees all traffic.**
The proxy decrypts all HTTPS to intercept bundle requests. It can see auth tokens, cookies, API responses — everything between the browser and Dataverse.

*Mitigation:* Inherent to how pcf-dev-proxy works, container or not. Not a new risk. It's a known tool from a known repo — just don't `npx` a random fork.

### The one to actually worry about

**Spectator-to-interactive escalation.** After handoff completes, the viewer switches to spectate mode (no input). This is enforced server-side in the relay — it drops input messages. If there's a bug in that filtering, a spectator could inject input into the authenticated browser while the agent is working.

*Mitigation:* On `completeHandoff`, call `Input.disable()` on the CDP session to kill the input domain entirely, rather than relying solely on the relay mode flag. Belt and suspenders.

### Non-issues

- **Agent can't steal credentials during handoff** — the MCP tool call is blocked. The agent is literally suspended, not executing.
- **Agent can't interact during handoff** — `browse()` and `screenshot()` throw errors while handoff is active.
- **CDP relay doesn't expose full CDP** — only `Input.*` events and screencast frames, not `Network.getCookies`, `Runtime.evaluate`, etc.

## Gotchas & Edge Cases

- **CDP session survives navigation** (OAuth redirects go through multiple domains) — `page.context().newCDPSession(page)` stays attached across navigations. But page crashes or `window.open()` could break it. Need error handling + auto-fail the handoff.
- **Keyboard input mapping** — `Input.dispatchKeyEvent` needs `windowsVirtualKeyCode`, `code`, `key`, `text` fields. Non-trivial for special keys and IME. Start with basic Latin + common modifiers, iterate.
- **Screencast CPU in ACA** — ~10-15% CPU for 1280x720 JPEG @10fps. Fine for single user, could stack with concurrent handoffs. Make quality/resolution configurable.
- **Canvas coordinate mapping** — mouse events need translation from canvas size to screencast frame dimensions (`metadata.deviceWidth`, `metadata.deviceHeight`). Get this wrong and clicks land in the wrong place.
- **User never clicks Done** — timeout handles it, but give the agent a useful error ("Handoff timed out after 300s — user did not complete interaction"), not just "timeout".
- **Browser crashes during handoff** — CDP proxy detects disconnect, auto-completes with error. Agent gets `isError: true`.
- **User closes viewer without clicking Done** — handoff stays active, user can re-open. Persistent banner on session card reminds them.
- **Multiple handoffs in sequence** — should work. Each `validate_handoff` call is independent, but the browser session (cookies, auth) persists within the same validation environment. Second handoff reuses the authenticated session.
- **Container restart during handoff** — everything dies. Same as all validate operations. Document it.
- **`wait_for` + "Done" button race** — `completeHandoff` must be idempotent. Second call is a no-op.
