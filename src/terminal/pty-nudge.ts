import type { SessionManager } from './session-manager.js';
import type { SessionStore } from '../db/session-store.js';

/**
 * PTY nudge service — injects notification text into a session's terminal
 * when inter-session messages arrive. The agent sees the notification and
 * knows to call read_messages.
 *
 * Rate-limited: max 1 nudge per 10 seconds per session.
 */
export class NudgeService {
  #sessionManager: SessionManager;
  #sessionStore: SessionStore;
  #lastNudge = new Map<string, number>();

  /** Minimum interval between nudges for the same session (ms). */
  static readonly RATE_LIMIT_MS = 10_000;

  constructor(sessionManager: SessionManager, sessionStore: SessionStore) {
    this.#sessionManager = sessionManager;
    this.#sessionStore = sessionStore;
  }

  nudgeDirectMessage(targetSessionId: string, fromSessionId: string): void {
    const fromDisplay = this.#getDisplay(fromSessionId);
    const text = this.#formatNudge(
      `📨 Message from session ${fromDisplay}`,
      'Use your read_messages tool to read it.',
    );
    this.#inject(targetSessionId, text);
  }

  nudgeChannelInvite(targetSessionId: string, fromSessionId: string, topic: string): void {
    const fromDisplay = this.#getDisplay(fromSessionId);
    const text = this.#formatNudge(
      `📬 Channel invite from session ${fromDisplay}`,
      `Topic: "${topic}"`,
      'Use your read_messages tool to see the invite details.',
    );
    this.#inject(targetSessionId, text);
  }

  nudgeChannelReply(
    targetSessionId: string,
    fromSessionId: string,
    topic: string,
    exchangeCount: number,
    maxExchanges: number,
  ): void {
    const fromDisplay = this.#getDisplay(fromSessionId);
    const text = this.#formatNudge(
      `💬 Reply in channel "${topic}" (${exchangeCount}/${maxExchanges})`,
      `From session ${fromDisplay}`,
      `Use your read_messages tool with the channel_id to read it.`,
    );
    this.#inject(targetSessionId, text);
  }

  nudgeChannelClosed(targetSessionId: string, closedBySessionId: string, topic: string): void {
    const closedByDisplay = this.#getDisplay(closedBySessionId);
    const text = this.#formatNudge(
      `🔒 Channel "${topic}" was closed by session ${closedByDisplay}`,
    );
    this.#inject(targetSessionId, text);
  }

  // ── Internals ──────────────────────────────────────────────────

  #inject(targetSessionId: string, text: string): void {
    // Rate limit check
    const now = Date.now();
    const last = this.#lastNudge.get(targetSessionId) ?? 0;
    if (now - last < NudgeService.RATE_LIMIT_MS) {
      console.log(`[pty-nudge] rate-limited for session ${targetSessionId}`);
      return;
    }

    // Find active session by DB id
    const session = this.#sessionManager.getSessionByDbId(targetSessionId);
    if (!session) {
      console.log(`[pty-nudge] session ${targetSessionId} not active, skipping nudge`);
      return;
    }

    try {
      session.terminal.write(text);
      this.#lastNudge.set(targetSessionId, now);
      console.log(`[pty-nudge] nudged session ${targetSessionId}`);
    } catch (err) {
      console.warn(`[pty-nudge] failed to write to session ${targetSessionId}:`, err);
    }
  }

  #formatNudge(...lines: string[]): string {
    const bar = '━'.repeat(50);
    const body = lines.map((l) => `  ${l}`).join('\r\n');
    return `\r\n\x1b[36m${bar}\r\n${body}\r\n${bar}\x1b[0m\r\n`;
  }

  #getDisplay(sessionId: string): string {
    try {
      const s = this.#sessionStore.getSession(sessionId);
      return s ? `#${s.displayId}` : sessionId.slice(0, 8);
    } catch {
      return sessionId.slice(0, 8);
    }
  }
}

export type { NudgeService as NudgeServiceType };
