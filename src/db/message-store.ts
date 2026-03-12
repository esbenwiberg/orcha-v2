import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

// ── Types ────────────────────────────────────────────────────────────

export interface MessageChannel {
  id: string;
  topic: string;
  joinSecret: string;
  createdBy: string;
  maxExchanges: number;
  exchangeCount: number;
  cooldownMs: number;
  ptyNudge: boolean;
  status: 'open' | 'closed' | 'expired';
  closedBy: string | null;
  summary: string | null;
  createdAt: Date;
  closedAt: Date | null;
  expiresAt: Date | null;
}

export interface ChannelMember {
  channelId: string;
  sessionId: string;
  role: string;
  joinedAt: Date;
}

export interface SessionMessage {
  id: string;
  channelId: string | null;
  fromSession: string;
  toSession: string | null;
  body: string;
  ptyNudge: boolean;
  createdAt: Date;
  readAt: Date | null;
  nudgedAt: Date | null;
}

export interface CreateChannelInput {
  topic: string;
  joinSecret: string;
  createdBy: string;
  myRole: string;
  maxExchanges?: number;
  ptyNudge?: boolean;
}

export interface SendMessageInput {
  fromSession: string;
  toSession: string;
  body: string;
  ptyNudge?: boolean;
}

export interface ChannelReplyInput {
  channelId: string;
  fromSession: string;
  body: string;
}

// ── Store ────────────────────────────────────────────────────────────

export class MessageStore {
  #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  // ── Channels ─────────────────────────────────────────────────────

  createChannel(input: CreateChannelInput): MessageChannel {
    const id = randomUUID();
    const now = new Date().toISOString();
    // Default TTL: 1 hour
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    this.#db.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO message_channels (id, topic, join_secret, created_by, max_exchanges, pty_nudge, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.topic, input.joinSecret, input.createdBy, input.maxExchanges ?? 20, input.ptyNudge !== false ? 1 : 0, now, expiresAt);

      // Creator auto-joins
      this.#db
        .prepare(
          `INSERT INTO channel_members (channel_id, session_id, role, joined_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(id, input.createdBy, input.myRole, now);
    })();

    return this.getChannel(id)!;
  }

  getChannel(id: string): MessageChannel | undefined {
    const row = this.#db.prepare('SELECT * FROM message_channels WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return undefined;
    return this.#rowToChannel(row);
  }

  joinChannel(channelId: string, sessionId: string, role: string): MessageChannel {
    const channel = this.getChannel(channelId);
    if (channel === undefined) throw new Error(`Channel not found: ${channelId}`);
    if (channel.status !== 'open') throw new Error(`Channel is ${channel.status}`);

    const now = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO channel_members (channel_id, session_id, role, joined_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(channelId, sessionId, role, now);

    return this.getChannel(channelId)!;
  }

  getChannelMembers(channelId: string): ChannelMember[] {
    const rows = this.#db
      .prepare('SELECT * FROM channel_members WHERE channel_id = ?')
      .all(channelId) as Record<string, unknown>[];
    return rows.map((r) => ({
      channelId: r['channel_id'] as string,
      sessionId: r['session_id'] as string,
      role: r['role'] as string,
      joinedAt: new Date(r['joined_at'] as string),
    }));
  }

  closeChannel(channelId: string, closedBy: string, summary?: string): MessageChannel {
    const channel = this.getChannel(channelId);
    if (channel === undefined) throw new Error(`Channel not found: ${channelId}`);

    const now = new Date().toISOString();
    this.#db
      .prepare(
        `UPDATE message_channels SET status = 'closed', closed_by = ?, closed_at = ?, summary = ?
         WHERE id = ?`,
      )
      .run(closedBy, now, summary ?? null, channelId);

    return this.getChannel(channelId)!;
  }

  /** Close channels that have passed their expires_at TTL. */
  expireChannels(): number {
    const now = new Date().toISOString();
    const result = this.#db
      .prepare(
        `UPDATE message_channels SET status = 'expired', closed_at = ?
         WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at < ?`,
      )
      .run(now, now);
    return result.changes;
  }

  listChannelsForSession(sessionId: string): MessageChannel[] {
    const rows = this.#db
      .prepare(
        `SELECT mc.* FROM message_channels mc
         JOIN channel_members cm ON cm.channel_id = mc.id
         WHERE cm.session_id = ?
         ORDER BY mc.created_at DESC`,
      )
      .all(sessionId) as Record<string, unknown>[];
    return rows.map((r) => this.#rowToChannel(r));
  }

  // ── Messages ─────────────────────────────────────────────────────

  /** Fire-and-forget direct message. */
  sendDirect(input: SendMessageInput): SessionMessage {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.#db
      .prepare(
        `INSERT INTO session_messages (id, from_session, to_session, body, pty_nudge, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.fromSession, input.toSession, input.body, input.ptyNudge !== false ? 1 : 0, now);
    return this.getMessage(id)!;
  }

  /** Send a reply in a channel. Enforces max_exchanges and cooldown. */
  sendChannelReply(input: ChannelReplyInput): SessionMessage {
    const channel = this.getChannel(input.channelId);
    if (channel === undefined) throw new Error(`Channel not found: ${input.channelId}`);
    if (channel.status !== 'open') throw new Error(`Channel is ${channel.status}`);
    if (channel.exchangeCount >= channel.maxExchanges) throw new Error('max_exchanges_reached');

    // Check cooldown — last message in channel
    const lastMsg = this.#db
      .prepare(
        `SELECT created_at FROM session_messages
         WHERE channel_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(input.channelId) as { created_at: string } | undefined;

    if (lastMsg) {
      const elapsed = Date.now() - new Date(lastMsg.created_at).getTime();
      if (elapsed < channel.cooldownMs) {
        throw new Error(`cooldown_active: ${channel.cooldownMs - elapsed}ms remaining`);
      }
    }

    const id = randomUUID();
    const now = new Date().toISOString();

    this.#db.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO session_messages (id, channel_id, from_session, body, pty_nudge, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.channelId, input.fromSession, input.body, channel.ptyNudge ? 1 : 0, now);

      this.#db
        .prepare('UPDATE message_channels SET exchange_count = exchange_count + 1 WHERE id = ?')
        .run(input.channelId);
    })();

    return this.getMessage(id)!;
  }

  getMessage(id: string): SessionMessage | undefined {
    const row = this.#db.prepare('SELECT * FROM session_messages WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return undefined;
    return this.#rowToMessage(row);
  }

  /** Get unread direct messages for a session. */
  getUnreadDirect(sessionId: string): SessionMessage[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM session_messages
         WHERE to_session = ? AND channel_id IS NULL AND read_at IS NULL
         ORDER BY created_at ASC`,
      )
      .all(sessionId) as Record<string, unknown>[];
    return rows.map((r) => this.#rowToMessage(r));
  }

  /** Get channel messages, optionally since a timestamp. */
  getChannelMessages(channelId: string, since?: string): SessionMessage[] {
    let sql = 'SELECT * FROM session_messages WHERE channel_id = ?';
    const params: unknown[] = [channelId];
    if (since) {
      sql += ' AND created_at > ?';
      params.push(since);
    }
    sql += ' ORDER BY created_at ASC';
    const rows = this.#db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.#rowToMessage(r));
  }

  /** Mark messages as read. */
  markRead(messageIds: string[]): void {
    if (messageIds.length === 0) return;
    const now = new Date().toISOString();
    const placeholders = messageIds.map(() => '?').join(',');
    this.#db
      .prepare(`UPDATE session_messages SET read_at = ? WHERE id IN (${placeholders})`)
      .run(now, ...messageIds);
  }

  /** Mark a message as nudged (PTY notification sent). */
  markNudged(messageId: string): void {
    const now = new Date().toISOString();
    this.#db
      .prepare('UPDATE session_messages SET nudged_at = ? WHERE id = ?')
      .run(now, messageId);
  }

  /** Count unread direct messages for a session. */
  countUnread(sessionId: string): number {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) as count FROM session_messages
         WHERE to_session = ? AND channel_id IS NULL AND read_at IS NULL`,
      )
      .get(sessionId) as { count: number };
    return row.count;
  }

  /** Get un-nudged messages for a session (direct + channel). */
  getUnnudged(sessionId: string): SessionMessage[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM session_messages
         WHERE nudged_at IS NULL AND pty_nudge = 1
           AND (
             (to_session = ? AND channel_id IS NULL)
             OR (channel_id IN (
               SELECT channel_id FROM channel_members WHERE session_id = ?
             ) AND from_session != ?)
           )
         ORDER BY created_at ASC`,
      )
      .all(sessionId, sessionId, sessionId) as Record<string, unknown>[];
    return rows.map((r) => this.#rowToMessage(r));
  }

  /** Get all messages for a session (sent + received, both direct and channel). */
  getAllForSession(sessionId: string): SessionMessage[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM session_messages
         WHERE from_session = ? OR to_session = ?
            OR channel_id IN (SELECT channel_id FROM channel_members WHERE session_id = ?)
         ORDER BY created_at DESC`,
      )
      .all(sessionId, sessionId, sessionId) as Record<string, unknown>[];
    return rows.map((r) => this.#rowToMessage(r));
  }

  /** Cleanup: delete messages and channels for a deleted session. */
  deleteForSession(sessionId: string): void {
    this.#db.transaction(() => {
      this.#db.prepare('DELETE FROM session_messages WHERE from_session = ? OR to_session = ?').run(sessionId, sessionId);
      this.#db.prepare('DELETE FROM channel_members WHERE session_id = ?').run(sessionId);
      // Close channels created by this session
      const now = new Date().toISOString();
      this.#db
        .prepare(
          `UPDATE message_channels SET status = 'closed', closed_by = 'system', closed_at = ?
           WHERE created_by = ? AND status = 'open'`,
        )
        .run(now, sessionId);
    })();
  }

  // ── Helpers ──────────────────────────────────────────────────────

  #rowToChannel(row: Record<string, unknown>): MessageChannel {
    return {
      id: row['id'] as string,
      topic: row['topic'] as string,
      joinSecret: row['join_secret'] as string,
      createdBy: row['created_by'] as string,
      maxExchanges: row['max_exchanges'] as number,
      exchangeCount: row['exchange_count'] as number,
      cooldownMs: row['cooldown_ms'] as number,
      ptyNudge: (row['pty_nudge'] as number) !== 0,
      status: row['status'] as 'open' | 'closed' | 'expired',
      closedBy: (row['closed_by'] as string) ?? null,
      summary: (row['summary'] as string) ?? null,
      createdAt: new Date(row['created_at'] as string),
      closedAt: row['closed_at'] ? new Date(row['closed_at'] as string) : null,
      expiresAt: row['expires_at'] ? new Date(row['expires_at'] as string) : null,
    };
  }

  #rowToMessage(row: Record<string, unknown>): SessionMessage {
    return {
      id: row['id'] as string,
      channelId: (row['channel_id'] as string) ?? null,
      fromSession: row['from_session'] as string,
      toSession: (row['to_session'] as string) ?? null,
      body: row['body'] as string,
      ptyNudge: (row['pty_nudge'] as number) !== 0,
      createdAt: new Date(row['created_at'] as string),
      readAt: row['read_at'] ? new Date(row['read_at'] as string) : null,
      nudgedAt: row['nudged_at'] ? new Date(row['nudged_at'] as string) : null,
    };
  }
}
