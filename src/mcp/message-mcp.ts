import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { MessageStore } from '../db/message-store.js';
import { SessionStore } from '../db/session-store.js';
import type { NudgeService } from '../terminal/pty-nudge.js';

/**
 * Per-session MCP server for inter-session messaging.
 * Endpoint: POST/GET/DELETE /mcp/messages/:sessionId
 */
export function createMessageMcpRouter(
  db: Database.Database,
  nudgeService: NudgeService,
): Router {
  const router = Router();
  const messageStore = new MessageStore(db);
  const sessionStore = new SessionStore(db);

  // Track active transports per Orcha session → MCP session
  const transports = new Map<string, Map<string, StreamableHTTPServerTransport>>();

  function getOrCreateTransport(
    orchaSessionId: string,
    mcpSessionId: string | undefined,
  ): StreamableHTTPServerTransport | undefined {
    const sessionTransports = transports.get(orchaSessionId);

    if (mcpSessionId && sessionTransports?.has(mcpSessionId)) {
      return sessionTransports.get(mcpSessionId);
    }

    // Only create new transports when no MCP session ID is provided (initialization)
    if (mcpSessionId) return undefined;

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (newSessionId) => {
        let map = transports.get(orchaSessionId);
        if (!map) {
          map = new Map();
          transports.set(orchaSessionId, map);
        }
        map.set(newSessionId, transport);
        console.log(`[mcp:messages] session initialized orchaSession=${orchaSessionId} mcpSession=${newSessionId}`);
      },
    });

    transport.onclose = () => {
      const map = transports.get(orchaSessionId);
      if (map) {
        for (const [k, v] of map) {
          if (v === transport) map.delete(k);
        }
        if (map.size === 0) transports.delete(orchaSessionId);
      }
    };

    const mcpServer = buildMcpServer(orchaSessionId, messageStore, sessionStore, nudgeService);
    mcpServer.connect(transport as Parameters<typeof mcpServer.connect>[0]).catch((err) => {
      console.error(`[mcp:messages] failed to connect transport for session ${orchaSessionId}:`, err);
    });

    return transport;
  }

  // POST /mcp/messages/:sessionId
  router.post('/mcp/messages/:sessionId', (req, res) => {
    const orchaSessionId = req.params['sessionId'] ?? '';
    const mcpSessionId = req.headers['mcp-session-id'] as string | undefined;

    const transport = getOrCreateTransport(orchaSessionId, mcpSessionId);
    if (!transport) {
      res.status(400).json({ error: 'Bad Request: no active MCP session' });
      return;
    }

    transport.handleRequest(req, res).catch((err) => {
      console.error(`[mcp:messages] error handling POST for session ${orchaSessionId}:`, err);
      if (!res.headersSent) res.status(500).send('Internal error');
    });
  });

  // GET /mcp/messages/:sessionId — SSE stream
  router.get('/mcp/messages/:sessionId', (req, res) => {
    const orchaSessionId = req.params['sessionId'] ?? '';
    const mcpSessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!mcpSessionId) {
      res.status(400).json({ error: 'Bad Request: Mcp-Session-Id header required for GET' });
      return;
    }

    const sessionTransports = transports.get(orchaSessionId);
    const transport = sessionTransports?.get(mcpSessionId);
    if (!transport) {
      res.status(404).json({ error: 'No active MCP session' });
      return;
    }

    transport.handleRequest(req, res).catch((err) => {
      console.error(`[mcp:messages] error handling GET SSE for session ${orchaSessionId}:`, err);
      if (!res.headersSent) res.status(500).send('Internal error');
    });
  });

  // DELETE /mcp/messages/:sessionId
  router.delete('/mcp/messages/:sessionId', (req, res) => {
    const orchaSessionId = req.params['sessionId'] ?? '';
    const mcpSessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!mcpSessionId) {
      res.status(400).json({ error: 'Bad Request: Mcp-Session-Id header required for DELETE' });
      return;
    }

    const sessionTransports = transports.get(orchaSessionId);
    const transport = sessionTransports?.get(mcpSessionId);
    if (!transport) {
      res.status(404).json({ error: 'No active MCP session' });
      return;
    }

    transport.handleRequest(req, res).catch((err) => {
      console.error(`[mcp:messages] error handling DELETE for session ${orchaSessionId}:`, err);
      if (!res.headersSent) res.status(500).send('Internal error');
    });
  });

  return router;
}

// ── Helpers ──────────────────────────────────────────────────────────

function resolveSessionDbId(
  targetDisplay: string,
  sessionStore: SessionStore,
): string | undefined {
  // Try numeric display ID first
  const num = parseInt(targetDisplay, 10);
  if (!isNaN(num)) {
    const s = sessionStore.getSessionByDisplayId(num);
    if (s) return s.id;
  }
  // Fall back to UUID
  const s = sessionStore.getSession(targetDisplay);
  return s?.id;
}

function getSessionDisplay(sessionId: string, sessionStore: SessionStore): string {
  const s = sessionStore.getSession(sessionId);
  return s ? `#${s.displayId}` : sessionId.slice(0, 8);
}

// ── MCP Server ───────────────────────────────────────────────────────

function buildMcpServer(
  orchaSessionId: string,
  messageStore: MessageStore,
  sessionStore: SessionStore,
  nudgeService: NudgeService,
): McpServer {
  const mcp = new McpServer(
    { name: 'orcha-messages', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  // --- send_message ---
  mcp.tool(
    'send_message',
    'Send a direct message to another session. Fire-and-forget — no reply expected. ' +
    'Use this to share context, findings, or code snippets with another session.',
    {
      target_session: z.string().describe(
        'Display ID (e.g. "42") or UUID of the target session.',
      ),
      body: z.string().max(10000).describe('The message content (max 10KB).'),
      pty_nudge: z.boolean().optional().describe(
        'Whether to inject a PTY notification into the target session (default true). ' +
        'Set to false for quiet delivery.',
      ),
    },
    async (args) => {
      try {
        const targetDbId = resolveSessionDbId(args.target_session, sessionStore);
        if (!targetDbId) {
          return {
            content: [{ type: 'text' as const, text: `Session "${args.target_session}" not found.` }],
            isError: true,
          };
        }

        const msg = messageStore.sendDirect({
          fromSession: orchaSessionId,
          toSession: targetDbId,
          body: args.body,
          ...(args.pty_nudge === false ? { ptyNudge: false } : {}),
        });

        // Trigger PTY nudge for the target
        if (msg.ptyNudge) {
          nudgeService.nudgeDirectMessage(targetDbId, orchaSessionId);
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ ok: true, message_id: msg.id }),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to send message: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // --- read_messages ---
  mcp.tool(
    'read_messages',
    'Read pending messages. Without channel_id, reads unread direct messages. ' +
    'With channel_id, reads channel messages since your last read.',
    {
      channel_id: z.string().optional().describe('Channel ID to read from. Omit for direct messages.'),
    },
    async (args) => {
      try {
        let messages;
        if (args.channel_id) {
          messages = messageStore.getChannelMessages(args.channel_id);
          const members = messageStore.getChannelMembers(args.channel_id);
          const channel = messageStore.getChannel(args.channel_id);

          const result = {
            channel: channel ? { topic: channel.topic, status: channel.status, exchanges: `${channel.exchangeCount}/${channel.maxExchanges}` } : null,
            members: members.map((m) => ({
              session: getSessionDisplay(m.sessionId, sessionStore),
              role: m.role,
            })),
            messages: messages.map((m) => ({
              id: m.id,
              from: getSessionDisplay(m.fromSession, sessionStore),
              body: m.body,
              at: m.createdAt.toISOString(),
            })),
          };

          // Mark as read
          messageStore.markRead(messages.map((m) => m.id));

          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        // Direct messages
        messages = messageStore.getUnreadDirect(orchaSessionId);
        const result = {
          unread_count: messages.length,
          messages: messages.map((m) => ({
            id: m.id,
            from: getSessionDisplay(m.fromSession, sessionStore),
            body: m.body,
            at: m.createdAt.toISOString(),
          })),
        };

        // Mark as read
        messageStore.markRead(messages.map((m) => m.id));

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to read messages: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // --- create_channel ---
  mcp.tool(
    'create_channel',
    'Create a collaboration channel with a scoped topic. Returns a join secret to share with the other session.',
    {
      topic: z.string().max(200).describe('What this channel is about.'),
      my_role: z.string().max(500).describe('Describe who you are and what you know, so the other session has context.'),
      max_exchanges: z.number().optional().describe('Max back-and-forth messages (default 20).'),
      invite_session: z.string().optional().describe('Display ID of a session to auto-invite.'),
      pty_nudge: z.boolean().optional().describe('Enable PTY nudge notifications for this channel (default true).'),
    },
    async (args) => {
      try {
        const joinSecret = randomBytes(16).toString('hex');

        const channel = messageStore.createChannel({
          topic: args.topic,
          joinSecret,
          createdBy: orchaSessionId,
          myRole: args.my_role,
          ...(args.max_exchanges !== undefined ? { maxExchanges: args.max_exchanges } : {}),
          ...(args.pty_nudge === false ? { ptyNudge: false } : {}),
        });

        // Auto-invite if requested
        if (args.invite_session) {
          const targetDbId = resolveSessionDbId(args.invite_session, sessionStore);
          if (targetDbId) {
            messageStore.sendDirect({
              fromSession: orchaSessionId,
              toSession: targetDbId,
              body: `You're invited to join a collaboration channel.\n` +
                `Topic: ${args.topic}\n` +
                `Use join_channel with channel_id="${channel.id}" and join_secret="${joinSecret}"`,
            });
            nudgeService.nudgeChannelInvite(targetDbId, orchaSessionId, channel.topic);
          }
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              channel_id: channel.id,
              join_secret: joinSecret,
              topic: channel.topic,
              max_exchanges: channel.maxExchanges,
              message: args.invite_session
                ? `Channel created and invite sent to session ${args.invite_session}.`
                : `Channel created. Share the channel_id and join_secret with the other session.`,
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to create channel: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // --- join_channel ---
  mcp.tool(
    'join_channel',
    'Join an existing collaboration channel using the secret provided by the channel creator.',
    {
      channel_id: z.string().describe('Channel ID to join.'),
      join_secret: z.string().describe('The join secret shared by the channel creator.'),
      my_role: z.string().max(500).describe('Describe who you are and what you know.'),
    },
    async (args) => {
      try {
        const channel = messageStore.getChannel(args.channel_id);
        if (!channel) {
          return {
            content: [{ type: 'text' as const, text: 'Channel not found.' }],
            isError: true,
          };
        }

        // Verify secret (plain comparison — not hashed for v1 simplicity)
        if (args.join_secret !== channel.joinSecret) {
          return {
            content: [{ type: 'text' as const, text: 'Invalid join secret.' }],
            isError: true,
          };
        }

        messageStore.joinChannel(args.channel_id, orchaSessionId, args.my_role);
        const members = messageStore.getChannelMembers(args.channel_id);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              topic: channel.topic,
              max_exchanges: channel.maxExchanges,
              members: members.map((m) => ({
                session: getSessionDisplay(m.sessionId, sessionStore),
                role: m.role,
              })),
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to join channel: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // --- reply ---
  mcp.tool(
    'reply',
    'Send a reply in a collaboration channel. Respects the channel\'s exchange limit and cooldown.',
    {
      channel_id: z.string().describe('Channel ID to reply in.'),
      body: z.string().max(10000).describe('Your reply (max 10KB).'),
    },
    async (args) => {
      try {
        const msg = messageStore.sendChannelReply({
          channelId: args.channel_id,
          fromSession: orchaSessionId,
          body: args.body,
        });

        const channel = messageStore.getChannel(args.channel_id)!;

        // Nudge other channel members
        const members = messageStore.getChannelMembers(args.channel_id);
        for (const m of members) {
          if (m.sessionId !== orchaSessionId && channel.ptyNudge) {
            nudgeService.nudgeChannelReply(
              m.sessionId,
              orchaSessionId,
              channel.topic,
              channel.exchangeCount,
              channel.maxExchanges,
            );
          }
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              message_id: msg.id,
              exchange_count: channel.exchangeCount,
              remaining: channel.maxExchanges - channel.exchangeCount,
            }),
          }],
        };
      } catch (err) {
        const errStr = String(err);
        if (errStr.includes('max_exchanges_reached') || errStr.includes('cooldown_active')) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: errStr }) }],
            isError: true,
          };
        }
        return {
          content: [{ type: 'text' as const, text: `Failed to reply: ${errStr}` }],
          isError: true,
        };
      }
    },
  );

  // --- close_channel ---
  mcp.tool(
    'close_channel',
    'Close a collaboration channel. Either member can close it.',
    {
      channel_id: z.string().describe('Channel ID to close.'),
      summary: z.string().optional().describe('Optional summary of what was discussed/resolved.'),
    },
    async (args) => {
      try {
        messageStore.closeChannel(args.channel_id, orchaSessionId, args.summary);

        // Notify other members
        const members = messageStore.getChannelMembers(args.channel_id);
        const channel = messageStore.getChannel(args.channel_id);
        for (const m of members) {
          if (m.sessionId !== orchaSessionId) {
            nudgeService.nudgeChannelClosed(
              m.sessionId,
              orchaSessionId,
              channel?.topic ?? 'unknown',
            );
          }
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to close channel: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );

  return mcp;
}
