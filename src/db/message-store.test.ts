import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from './connection.js';
import { runMigrations } from './migrate.js';
import { MessageStore } from './message-store.js';

const MIGRATIONS_DIR = 'src/db/migrations';

describe('MessageStore', () => {
  let db: Database.Database;
  let store: MessageStore;

  beforeEach(() => {
    db = openDatabase(':memory:');
    runMigrations(db, MIGRATIONS_DIR);
    store = new MessageStore(db);
  });

  // ── Direct messages ────────────────────────────────────────────

  describe('sendDirect / getUnreadDirect', () => {
    it('delivers a direct message to the target', () => {
      const msg = store.sendDirect({
        fromSession: 'session-a',
        toSession: 'session-b',
        body: 'hello from A',
      });

      expect(msg.id).toBeTruthy();
      expect(msg.channelId).toBeNull();
      expect(msg.fromSession).toBe('session-a');
      expect(msg.toSession).toBe('session-b');
      expect(msg.body).toBe('hello from A');
      expect(msg.readAt).toBeNull();
      expect(msg.ptyNudge).toBe(true);
    });

    it('returns unread messages for the target session', () => {
      store.sendDirect({ fromSession: 'a', toSession: 'b', body: 'msg 1' });
      store.sendDirect({ fromSession: 'a', toSession: 'b', body: 'msg 2' });
      store.sendDirect({ fromSession: 'a', toSession: 'c', body: 'msg for c' });

      const unread = store.getUnreadDirect('b');
      expect(unread).toHaveLength(2);
      expect(unread[0]!.body).toBe('msg 1');
      expect(unread[1]!.body).toBe('msg 2');
    });

    it('markRead clears unread state', () => {
      const msg = store.sendDirect({ fromSession: 'a', toSession: 'b', body: 'hi' });
      store.markRead([msg.id]);

      const unread = store.getUnreadDirect('b');
      expect(unread).toHaveLength(0);
    });

    it('countUnread returns correct count', () => {
      store.sendDirect({ fromSession: 'a', toSession: 'b', body: '1' });
      store.sendDirect({ fromSession: 'a', toSession: 'b', body: '2' });
      expect(store.countUnread('b')).toBe(2);

      const msgs = store.getUnreadDirect('b');
      store.markRead(msgs.map((m) => m.id));
      expect(store.countUnread('b')).toBe(0);
    });

    it('ptyNudge=false is respected', () => {
      const msg = store.sendDirect({
        fromSession: 'a',
        toSession: 'b',
        body: 'quiet',
        ptyNudge: false,
      });
      expect(msg.ptyNudge).toBe(false);
    });
  });

  // ── Channels ───────────────────────────────────────────────────

  describe('channels', () => {
    it('creates a channel and auto-joins creator', () => {
      const ch = store.createChannel({
        topic: 'credential API',
        joinSecret: 'secret123',
        createdBy: 'session-a',
        myRole: 'MCP tool builder',
      });

      expect(ch.id).toBeTruthy();
      expect(ch.topic).toBe('credential API');
      expect(ch.status).toBe('open');
      expect(ch.maxExchanges).toBe(20);
      expect(ch.exchangeCount).toBe(0);
      expect(ch.ptyNudge).toBe(true);

      const members = store.getChannelMembers(ch.id);
      expect(members).toHaveLength(1);
      expect(members[0]!.sessionId).toBe('session-a');
      expect(members[0]!.role).toBe('MCP tool builder');
    });

    it('join adds a member', () => {
      const ch = store.createChannel({
        topic: 'test',
        joinSecret: 'sec',
        createdBy: 'a',
        myRole: 'role-a',
      });

      store.joinChannel(ch.id, 'b', 'role-b');
      const members = store.getChannelMembers(ch.id);
      expect(members).toHaveLength(2);
    });

    it('join is idempotent', () => {
      const ch = store.createChannel({
        topic: 'test',
        joinSecret: 'sec',
        createdBy: 'a',
        myRole: 'role-a',
      });

      store.joinChannel(ch.id, 'b', 'role-b');
      store.joinChannel(ch.id, 'b', 'role-b'); // duplicate
      const members = store.getChannelMembers(ch.id);
      expect(members).toHaveLength(2);
    });

    it('close transitions status', () => {
      const ch = store.createChannel({
        topic: 'test',
        joinSecret: 'sec',
        createdBy: 'a',
        myRole: 'r',
      });

      const closed = store.closeChannel(ch.id, 'a', 'We figured it out');
      expect(closed.status).toBe('closed');
      expect(closed.closedBy).toBe('a');
      expect(closed.summary).toBe('We figured it out');
    });

    it('listChannelsForSession returns only joined channels', () => {
      store.createChannel({ topic: 'ch1', joinSecret: 's', createdBy: 'a', myRole: 'r' });
      store.createChannel({ topic: 'ch2', joinSecret: 's', createdBy: 'b', myRole: 'r' });

      const channels = store.listChannelsForSession('a');
      expect(channels).toHaveLength(1);
      expect(channels[0]!.topic).toBe('ch1');
    });

    it('ptyNudge=false on channel is stored', () => {
      const ch = store.createChannel({
        topic: 'quiet',
        joinSecret: 'sec',
        createdBy: 'a',
        myRole: 'r',
        ptyNudge: false,
      });
      expect(ch.ptyNudge).toBe(false);
    });
  });

  // ── Channel replies ────────────────────────────────────────────

  describe('sendChannelReply', () => {
    it('increments exchange count', () => {
      const ch = store.createChannel({
        topic: 'test',
        joinSecret: 'sec',
        createdBy: 'a',
        myRole: 'r',
        maxExchanges: 5,
      });
      store.joinChannel(ch.id, 'b', 'r2');

      store.sendChannelReply({ channelId: ch.id, fromSession: 'a', body: 'hello' });
      const updated = store.getChannel(ch.id)!;
      expect(updated.exchangeCount).toBe(1);
    });

    it('throws when max_exchanges reached', () => {
      const ch = store.createChannel({
        topic: 'test',
        joinSecret: 'sec',
        createdBy: 'a',
        myRole: 'r',
        maxExchanges: 1,
      });

      // Override cooldown for test
      db.prepare('UPDATE message_channels SET cooldown_ms = 0 WHERE id = ?').run(ch.id);

      store.sendChannelReply({ channelId: ch.id, fromSession: 'a', body: 'one' });
      expect(() => {
        store.sendChannelReply({ channelId: ch.id, fromSession: 'a', body: 'two' });
      }).toThrow('max_exchanges_reached');
    });

    it('throws when channel is closed', () => {
      const ch = store.createChannel({
        topic: 'test',
        joinSecret: 'sec',
        createdBy: 'a',
        myRole: 'r',
      });
      store.closeChannel(ch.id, 'a');

      expect(() => {
        store.sendChannelReply({ channelId: ch.id, fromSession: 'a', body: 'nope' });
      }).toThrow('closed');
    });

    it('getChannelMessages returns messages in order', () => {
      const ch = store.createChannel({
        topic: 'test',
        joinSecret: 'sec',
        createdBy: 'a',
        myRole: 'r',
      });
      db.prepare('UPDATE message_channels SET cooldown_ms = 0 WHERE id = ?').run(ch.id);

      store.sendChannelReply({ channelId: ch.id, fromSession: 'a', body: 'first' });
      store.sendChannelReply({ channelId: ch.id, fromSession: 'b', body: 'second' });

      const msgs = store.getChannelMessages(ch.id);
      expect(msgs).toHaveLength(2);
      expect(msgs[0]!.body).toBe('first');
      expect(msgs[1]!.body).toBe('second');
    });
  });

  // ── Expiry ─────────────────────────────────────────────────────

  describe('expireChannels', () => {
    it('expires channels past their TTL', () => {
      const ch = store.createChannel({
        topic: 'test',
        joinSecret: 'sec',
        createdBy: 'a',
        myRole: 'r',
      });

      // Set expires_at to the past
      db.prepare("UPDATE message_channels SET expires_at = datetime('now', '-1 hour') WHERE id = ?").run(ch.id);

      const count = store.expireChannels();
      expect(count).toBe(1);

      const expired = store.getChannel(ch.id)!;
      expect(expired.status).toBe('expired');
    });

    it('does not expire channels still within TTL', () => {
      store.createChannel({
        topic: 'test',
        joinSecret: 'sec',
        createdBy: 'a',
        myRole: 'r',
      });

      const count = store.expireChannels();
      expect(count).toBe(0);
    });
  });

  // ── Cleanup ────────────────────────────────────────────────────

  describe('deleteForSession', () => {
    it('removes messages sent to and from the session', () => {
      store.sendDirect({ fromSession: 'a', toSession: 'b', body: 'hi' });
      store.sendDirect({ fromSession: 'b', toSession: 'a', body: 'hi back' });

      store.deleteForSession('a');

      // Both messages should be gone since 'a' is sender or receiver
      const all = store.getAllForSession('a');
      expect(all).toHaveLength(0);
    });

    it('removes channel membership', () => {
      const ch = store.createChannel({
        topic: 'test',
        joinSecret: 'sec',
        createdBy: 'a',
        myRole: 'r',
      });
      store.joinChannel(ch.id, 'b', 'r2');

      store.deleteForSession('a');

      const members = store.getChannelMembers(ch.id);
      expect(members).toHaveLength(1);
      expect(members[0]!.sessionId).toBe('b');
    });

    it('closes channels created by the deleted session', () => {
      const ch = store.createChannel({
        topic: 'test',
        joinSecret: 'sec',
        createdBy: 'a',
        myRole: 'r',
      });

      store.deleteForSession('a');

      const closed = store.getChannel(ch.id)!;
      expect(closed.status).toBe('closed');
      expect(closed.closedBy).toBe('system');
    });
  });

  // ── Nudge tracking ─────────────────────────────────────────────

  describe('getUnnudged / markNudged', () => {
    it('returns un-nudged direct messages', () => {
      store.sendDirect({ fromSession: 'a', toSession: 'b', body: 'hey' });

      const unnudged = store.getUnnudged('b');
      expect(unnudged).toHaveLength(1);
    });

    it('markNudged excludes from getUnnudged', () => {
      const msg = store.sendDirect({ fromSession: 'a', toSession: 'b', body: 'hey' });
      store.markNudged(msg.id);

      const unnudged = store.getUnnudged('b');
      expect(unnudged).toHaveLength(0);
    });

    it('respects ptyNudge=false', () => {
      store.sendDirect({ fromSession: 'a', toSession: 'b', body: 'quiet', ptyNudge: false });

      const unnudged = store.getUnnudged('b');
      expect(unnudged).toHaveLength(0);
    });
  });
});
