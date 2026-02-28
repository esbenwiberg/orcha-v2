import { randomBytes } from 'node:crypto';

/** How long a ticket is valid (ms). */
const TICKET_TTL_MS = 30_000;

interface Ticket {
  expiresAt: number;
}

const _tickets = new Map<string, Ticket>();

/**
 * Issue a one-time WebSocket auth ticket.
 * Tickets are 64 hex chars of randomness, valid for 30 seconds.
 */
export function issueTicket(): string {
  const token = randomBytes(32).toString('hex');
  _tickets.set(token, { expiresAt: Date.now() + TICKET_TTL_MS });
  // Opportunistic cleanup of expired tickets
  for (const [k, v] of _tickets) {
    if (v.expiresAt < Date.now()) _tickets.delete(k);
  }
  return token;
}

/**
 * Verify and consume a ticket. Returns true if valid; deletes it on success
 * (one-time use).
 */
export function consumeTicket(token: string): boolean {
  const ticket = _tickets.get(token);
  if (ticket === undefined) return false;
  _tickets.delete(token);
  return ticket.expiresAt >= Date.now();
}
