# Session Messaging — Design Plan

Inter-session messaging for Orcha: let agent sessions share context and
collaborate without manual copy-paste.

---

## Problem

Sessions are isolated by design (separate worktrees, PTYs, credentials).
But sometimes two sessions work on related things and need to exchange
context. Today the user is the bottleneck — copy-pasting between terminal
tabs. That sucks.

## Two Use Cases

| Mode | Description | Example |
|------|-------------|---------|
| **Send** | Fire-and-forget. Push info to another session. No reply expected. | "Here's the API schema you asked about" |
| **Channel** | Scoped collaboration. Roles, topic, exchange limit. Back-and-forth. | "Help me understand how credential provisioning works" |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         ORCHA SERVER                                │
│                                                                     │
│  ┌──────────┐    ┌──────────────┐    ┌──────────────────────────┐  │
│  │ Message   │    │  Event Bus   │    │   Message MCP Server     │  │
│  │ Store     │◄──►│  (pub/sub)   │    │   /mcp/messages/:sid     │  │
│  │ (SQLite)  │    │              │    │                          │  │
│  └─────┬─────┘    └──────┬───────┘    │  Tools:                  │  │
│        │                 │            │   • send_message          │  │
│        │                 │            │   • create_channel        │  │
│        │                 │            │   • join_channel          │  │
│        │                 │            │   • read_messages         │  │
│        │                 │            │   • reply                 │  │
│        │                 │            │   • close_channel         │  │
│        │                 │            └────────┬─────────────────┘  │
│        │                 │                     │                    │
│        │                 ▼                     │                    │
│        │           ┌───────────┐               │                    │
│        │           │  PTY      │◄──────────────┘                    │
│        │           │  Nudge    │  inject notification               │
│        │           │  Service  │  when message arrives              │
│        │           └───────────┘                                    │
│        │                                                            │
└────────┼────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        SQLite Tables                                │
│                                                                     │
│  channels ──┬── channel_members                                     │
│             └── messages                                            │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Message Flow — Fire-and-Forget

```
  Session A (sender)              Orcha Server              Session B (receiver)
  ══════════════════              ════════════              ═══════════════════
         │                             │                            │
         │  MCP: send_message          │                            │
         │  (target: session-B,        │                            │
         │   body: "schema is...")     │                            │
         ├────────────────────────────►│                            │
         │                             │                            │
         │                             │  1. Store in messages      │
         │                             │     table (no channel)     │
         │                             │                            │
         │                             │  2. PTY nudge inject       │
         │                             │─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─►│
         │                             │                            │
         │                             │  ┌──────────────────────┐  │
         │                             │  │ [ORCHA] Message from │  │
         │                             │  │ "self-validate-mcp"  │  │
         │                             │  │ Use read_messages to  │  │
         │                             │  │ read it.              │  │
         │                             │  └──────────────────────┘  │
         │                             │                            │
         │                             │  3. Agent calls            │
         │                             │     read_messages          │
         │                             │◄───────────────────────────┤
         │                             │                            │
         │                             │  4. Returns message body   │
         │                             ├───────────────────────────►│
         │                             │                            │
         │         tool result: ok     │                            │
         │◄────────────────────────────┤                            │
         │                             │                            │
```

### Message Flow — Collaboration Channel

```
  Session A                        Orcha Server                    Session B
  ═════════                        ════════════                    ═════════
      │                                 │                              │
      │  MCP: create_channel            │                              │
      │  topic: "credential API"        │                              │
      │  my_role: "building MCP tool"   │                              │
      │  max_exchanges: 10              │                              │
      ├────────────────────────────────►│                              │
      │                                 │                              │
      │  { channel_id, join_secret }    │                              │
      │◄────────────────────────────────┤                              │
      │                                 │                              │
      │  MCP: send_message              │                              │
      │  (target: session-B,            │                              │
      │   body: "join channel X,        │                              │
      │   secret: abc123")              │                              │
      ├────────────────────────────────►│                              │
      │                                 │  PTY nudge                   │
      │                                 │─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─►│
      │                                 │                              │
      │                                 │  MCP: join_channel           │
      │                                 │  channel_id, secret,         │
      │                                 │  my_role: "orcha codebase    │
      │                                 │   owner"                     │
      │                                 │◄─────────────────────────────┤
      │                                 │                              │
      │ ┌─────────────── exchange loop (max 10) ─────────────────────┐ │
      │ │                               │                            │ │
      │ │  PTY nudge: "new reply"       │                            │ │
      │ │◄─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │                            │ │
      │ │                               │                            │ │
      │ │  MCP: read_messages           │                            │ │
      │ ├──────────────────────────────►│                            │ │
      │ │  { from: B, body: "..." }     │                            │ │
      │ │◄──────────────────────────────┤                            │ │
      │ │                               │                            │ │
      │ │  MCP: reply(channel, "...")    │                            │ │
      │ ├──────────────────────────────►│                            │ │
      │ │                               │  PTY nudge: "new reply"    │ │
      │ │                               │─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─►│ │
      │ │                               │                            │ │
      │ │                               │  MCP: read_messages        │ │
      │ │                               │◄───────────────────────────┤ │
      │ │                               │  MCP: reply(channel, "..") │ │
      │ │                               │◄───────────────────────────┤ │
      │ │                               │                            │ │
      │ └──────────── repeats until max_exchanges or close ──────────┘ │
      │                                 │                              │
      │  MCP: close_channel             │                              │
      ├────────────────────────────────►│                              │
      │                                 │  PTY nudge: "channel closed" │
      │                                 │─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─►│
      │                                 │                              │
```

---

## DB Schema

New migration: `src/db/migrations/017-session-messaging.sql`

```sql
-- Channels for scoped collaboration
CREATE TABLE IF NOT EXISTS message_channels (
    id            TEXT PRIMARY KEY,
    topic         TEXT NOT NULL,
    join_secret   TEXT NOT NULL,          -- bcrypt hash, verified on join
    created_by    TEXT NOT NULL,          -- session db id
    max_exchanges INTEGER DEFAULT 20,
    exchange_count INTEGER DEFAULT 0,
    cooldown_ms   INTEGER DEFAULT 5000,  -- min time between exchanges
    status        TEXT NOT NULL DEFAULT 'open',  -- open | closed | expired
    closed_by     TEXT,                  -- session that closed it
    summary       TEXT,                  -- auto-generated on close
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at     TEXT,
    expires_at    TEXT                   -- TTL, auto-close if abandoned
);

-- Channel membership with role context
CREATE TABLE IF NOT EXISTS channel_members (
    channel_id    TEXT NOT NULL REFERENCES message_channels(id),
    session_id    TEXT NOT NULL,          -- session db id
    role          TEXT NOT NULL,          -- "building MCP tool for X"
    joined_at     TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (channel_id, session_id)
);

-- Messages — used for both fire-and-forget and channel messages
CREATE TABLE IF NOT EXISTS session_messages (
    id            TEXT PRIMARY KEY,
    channel_id    TEXT REFERENCES message_channels(id),  -- NULL = fire-and-forget
    from_session  TEXT NOT NULL,          -- session db id
    to_session    TEXT,                   -- session db id, NULL if channel broadcast
    body          TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    read_at       TEXT,                   -- NULL until recipient reads
    nudged_at     TEXT                    -- NULL until PTY nudge sent
);

CREATE INDEX idx_messages_to_session ON session_messages(to_session, read_at);
CREATE INDEX idx_messages_channel    ON session_messages(channel_id, created_at);
```

---

## MCP Tool Definitions

New MCP server: `src/mcp/message-mcp.ts`
Endpoint: `POST/GET/DELETE /mcp/messages/:sessionId`

Injected into sessions via settings.json alongside validate + orcha servers.

### Tools

#### `send_message`
Fire-and-forget. No channel needed.

```
Input:
  target_session: string    — display ID or name of target session
  body: string              — the message content

Output:
  { ok: true, message_id: string }
```

#### `create_channel`
Open a collaboration channel.

```
Input:
  topic: string             — what this channel is about
  my_role: string           — who you are / what you know
  max_exchanges?: number    — cap on back-and-forth (default 20)
  invite_session?: string   — auto-send invite to this session

Output:
  { channel_id: string, join_secret: string }
```

#### `join_channel`
Join an existing channel.

```
Input:
  channel_id: string
  join_secret: string
  my_role: string           — who you are / what you know

Output:
  { ok: true, topic: string, members: [{ session, role }] }
```

#### `read_messages`
Pull unread messages. Works for both direct and channel messages.

```
Input:
  channel_id?: string       — if set, read from channel; else read direct inbox

Output:
  { messages: [{ id, from_session, from_role?, body, created_at }] }
```

#### `reply`
Send a message in a channel. Enforces max_exchanges and cooldown.

```
Input:
  channel_id: string
  body: string

Output:
  { ok: true, exchange_count: number, remaining: number }
  -- or --
  { error: "channel_closed" | "max_exchanges_reached" | "cooldown_active" }
```

#### `close_channel`
Either side can close. Generates summary.

```
Input:
  channel_id: string
  summary?: string          — optional closing summary

Output:
  { ok: true }
```

---

## PTY Nudge Service

New module: `src/terminal/pty-nudge.ts`

When a message arrives for a session, the nudge service injects a
notification into the PTY. The agent sees it as terminal output and
knows to call `read_messages`.

### Nudge Format

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📨 ORCHA: Message from session #42 "self-validate-mcp"
   Use your read_messages tool to see it.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

For channel replies:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💬 ORCHA: New reply in channel "credential API" (4/10)
   From session #42 (role: "orcha codebase owner")
   Use your read_messages tool with channel_id to see it.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### Implementation

```typescript
interface NudgeService {
  // Called by message store after insert
  nudge(targetSessionId: string, preview: NudgePreview): void;
}

interface NudgePreview {
  type: 'direct' | 'channel_reply' | 'channel_invite' | 'channel_closed';
  fromSessionDisplay: string;     // "#42 self-validate-mcp"
  channelTopic?: string;
  exchangeCount?: string;         // "4/10"
  fromRole?: string;
}
```

The nudge service:
1. Looks up the active session's `SessionTerminal`
2. Calls `terminal.write(formatNudge(preview))` to inject into PTY
3. Updates `session_messages.nudged_at`

### Safety

- **Idle detection**: only nudge when the agent is between tool calls.
  Watch the output buffer for Claude's "thinking" indicator or tool
  call boundaries. If mid-action, queue the nudge and retry after a
  short delay (2-3s).
- **Dedup**: don't nudge for the same message twice (`nudged_at` check).
- **Rate limit**: max 1 nudge per 10 seconds per session to avoid
  flooding.

---

## Tool Description Trick (Belt & Suspenders)

When a session has unread messages, update the `read_messages` tool
description dynamically via `notifications/tools/list_changed`:

```
Before:  "Read pending messages from other sessions."
After:   "Read pending messages from other sessions. ⚡ You have 2 unread messages."
```

Claude Code handles `tools/list_changed` — it re-fetches the tool list.
The agent sees the updated description on its next planning step. This
works even if the PTY nudge was missed.

---

## UI — Messaging Panel

Accessible from the session detail page. Shows inbox + active channels.

### Session Detail — Message Tab

```
┌─────────────────────────────────────────────────────────────────────┐
│  Session #42 — self-validate-mcp                     [Terminal] [▾] │
├──────────┬──────────┬────────────┬───────────┬──────────────────────┤
│ Terminal │ Messages │  Channels  │   Logs    │       Config         │
├──────────┴──────────┴────────────┴───────────┴──────────────────────┤
│                                                                     │
│  📨 Direct Messages                                    [Send New ▾] │
│  ───────────────────────────────────────────────────────────────     │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ From: #38 "orcha-repo"              12:34:02  ● unread        │ │
│  │ "The credential provisioning endpoint is POST /api/creds/..." │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ From: #35 "auth-service"            11:20:15  ○ read          │ │
│  │ "Here's the OAuth flow diagram you asked about..."            │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│                                                                     │
│  💬 Active Channels                                                 │
│  ───────────────────────────────────────────────────────────────     │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ 🟢 "credential API"                          4/10 exchanges   │ │
│  │    Members: #42 (you), #38 "orcha-repo"                       │ │
│  │    Last: "The provisioning flow starts in..."     12:35:10    │ │
│  │                                                    [View ▸]   │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ ⚫ "sandbox config" (closed)                     6/6 exchanges │ │
│  │    Summary: "Agreed to use landlock mode with..."              │ │
│  │                                                    [View ▸]   │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Channel Detail View

```
┌─────────────────────────────────────────────────────────────────────┐
│  Channel: "credential API"                   🟢 Open    4/10       │
│  ─────────────────────────────────────────────────────────────────  │
│                                                                     │
│  Topic: How does credential provisioning work in Orcha?             │
│                                                                     │
│  Members:                                                           │
│    #42 "self-validate-mcp" — Building MCP tool that needs creds    │
│    #38 "orcha-repo"        — Orcha codebase, credential-manager    │
│                                                                     │
│  ─────────────────────────────────────────────────────────────────  │
│                                                                     │
│  #42  12:33:15                                                      │
│  │ How does credential provisioning work? I need to call it from   │
│  │ my MCP tool but I don't understand the flow.                    │
│                                                                     │
│  #38  12:33:22                                                      │
│  │ The provisioning flow starts in credential-manager.ts. It       │
│  │ calls each provider in parallel: azure, github, devops. Each    │
│  │ returns a credential grant or throws. If any throw, it rolls    │
│  │ back all successful grants.                                     │
│                                                                     │
│  #42  12:34:01                                                      │
│  │ Got it. So I should call provisionCredentials() and handle      │
│  │ the rollback error case. What's the return type?                │
│                                                                     │
│  #38  12:34:08                                                      │
│  │ ActiveCredentials — it's in credentials/types.ts. Has fields    │
│  │ for each provider: azure?: { token }, github?: { pat }, etc.    │
│                                                                     │
│  ─────────────────────────────────────────────────────────────────  │
│  Exchanges: 4 of 10   │  Cooldown: 5s   │          [Close Channel] │
└─────────────────────────────────────────────────────────────────────┘
```

### Send Message Modal

```
┌───────────────────────────────────────────────┐
│  Send Message                           [ ✕ ] │
│  ─────────────────────────────────────────     │
│                                               │
│  To Session:                                  │
│  ┌───────────────────────────────────────┐    │
│  │ #38 "orcha-repo"                    ▾ │    │
│  └───────────────────────────────────────┘    │
│  (only shows active sessions)                 │
│                                               │
│  Message:                                     │
│  ┌───────────────────────────────────────┐    │
│  │ The API schema for the credential     │    │
│  │ endpoint is:                          │    │
│  │ POST /api/credentials/provision       │    │
│  │ Body: { profileId, sessionId }        │    │
│  │                                       │    │
│  └───────────────────────────────────────┘    │
│                                               │
│                              [ Cancel ] [Send]│
└───────────────────────────────────────────────┘
```

### Dashboard — Message Indicators

```
┌─────────────────────────────────────────────────────────────────────┐
│  Sessions                                              [+ New]      │
├──────────┬─────────────────────┬──────────┬────────┬────────────────┤
│  ID      │  Name               │  Status  │  Msgs  │  Channels     │
├──────────┼─────────────────────┼──────────┼────────┼────────────────┤
│  #42     │  self-validate-mcp  │ 🟢 run   │  2 💬  │  1 active     │
│  #38     │  orcha-repo         │ 🟢 run   │  —     │  1 active     │
│  #35     │  auth-service       │ 🟢 run   │  —     │  —            │
│  #31     │  frontend-rework    │ ⚫ done  │  —     │  —            │
└──────────┴─────────────────────┴──────────┴────────┴────────────────┘
```

---

## Integration Points with Existing Code

### 1. New MCP Server (`src/mcp/message-mcp.ts`)

Follows the exact pattern of `validate-mcp.ts`:
- Streamable HTTP transport
- Per-session transport tracking
- Registered at `/mcp/messages/:sessionId`

### 2. Settings Injection (`src/tasks/task-processor.ts`)

Add `messages` server alongside `validate` and `orcha` in
`#buildSessionClaudeFiles()`:

```typescript
mcpServers['messages'] = {
  type: 'http',
  url: `${orchaHost}/mcp/messages/${sessionId}`,
};
```

### 3. Message Store (`src/db/message-store.ts`)

New store following existing pattern: `new MessageStore(deps.db)`.
Handles CRUD for channels, members, messages.

### 4. PTY Nudge (`src/terminal/pty-nudge.ts`)

Hooks into `SessionManager` to access active sessions and their
terminals. Listens to event bus for new message events.

### 5. Event Bus Extensions (`src/web/services/event-bus.ts`)

New event types for SSE → UI updates:

```typescript
{ type: 'message-received', sessionId, messageId }
{ type: 'channel-update', channelId, exchangeCount }
```

### 6. UI Routes (`src/web/routes/messages.ts`)

HTMX partials for the messaging tab, channel view, send modal.
Follows existing pattern (partials return HTML fragments).

---

## Implementation Order

```
Phase 1 — Fire-and-forget (the quick win)
══════════════════════════════════════════
 1. DB migration (channels + messages tables)
 2. MessageStore (CRUD)
 3. Message MCP server (send_message + read_messages only)
 4. Inject MCP server into session settings.json
 5. PTY nudge service (basic: inject on message received)
 6. UI: message tab on session detail page
 7. UI: send modal
 8. UI: unread indicator on dashboard

Phase 2 — Collaboration channels
══════════════════════════════════
 9. Channel creation / join / close tools
 10. Reply tool with exchange counting + cooldown
 11. Tool description trick (dynamic unread count)
 12. UI: channel detail view
 13. UI: channel indicators on dashboard
 14. Auto-summary on channel close

Phase 3 — Polish
═════════════════
 15. Idle detection for smarter nudge timing
 16. Channel expiry (TTL cleanup)
 17. Message search / history
 18. User-initiated channels from UI (not just agent-created)
```

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Agents ignore PTY nudges | Messages never read | Tool description trick as backup; user can tell agent "check messages" |
| Collaboration loops burn tokens | Wasted compute, blurred context | `max_exchanges` hard cap, cooldown timer, user visibility in UI |
| PTY injection corrupts agent mid-action | Broken tool calls, garbled output | Idle detection, queue + retry, clear delimiters |
| Channel secrets leak in terminal output | Unauthorized joins | Hash secrets server-side, short-lived secrets, Orcha validates membership |
| Abandoned channels pile up | DB clutter | `expires_at` TTL, cleanup job in system routes |
| Session ends mid-channel | Orphaned channel | Auto-close channel on session exit, notify other members |

---

## Open Questions

1. **Should the user be able to send messages from the UI too?** (not just
   agents) — Probably yes, especially for "hey agent, look at this".

2. **Multi-member channels?** — Design supports it (channel_members is
   many-to-many) but initial implementation is 1:1 only.

3. **Message size limits?** — Large payloads (full files) could bloat the
   DB. Cap at ~10KB per message? Or store large payloads as files and
   reference them?

4. **Cross-instance messaging?** — If Orcha runs multiple instances, do
   messages cross instance boundaries? Probably not for v1.

5. **Notification sound / browser alert?** — When a message arrives, should
   the UI ping the user? Could be annoying. Maybe opt-in.
