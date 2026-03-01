import type { SessionStatus } from './types.js';

export const VALID_TRANSITIONS: ReadonlyMap<SessionStatus, ReadonlySet<SessionStatus>> = new Map([
  ['pending', new Set<SessionStatus>(['starting', 'cancelled'])],
  ['starting', new Set<SessionStatus>(['running', 'failed', 'cancelled'])],
  ['running', new Set<SessionStatus>(['paused', 'completed', 'failed', 'cancelled'])],
  ['paused', new Set<SessionStatus>(['running', 'cancelled'])],
  ['completed', new Set<SessionStatus>()],
  ['failed', new Set<SessionStatus>(['starting'])],
  ['cancelled', new Set<SessionStatus>(['starting'])],
]);

export function isValidTransition(from: SessionStatus, to: SessionStatus): boolean {
  return VALID_TRANSITIONS.get(from)?.has(to) ?? false;
}

export function assertValidTransition(from: SessionStatus, to: SessionStatus): void {
  if (!isValidTransition(from, to)) {
    throw new TypeError(`Invalid status transition: ${from} → ${to}`);
  }
}
