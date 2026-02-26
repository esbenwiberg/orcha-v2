import crypto from 'node:crypto';
import type express from 'express';
import { createAppError } from '../errors.js';

/**
 * Timing-safe comparison of two string secrets.
 * Pads both values to the same length before calling timingSafeEqual so that
 * the comparison time does not leak the length of the expected value.
 * Returns true only when both length and content match.
 */
export function timingSafeCompare(expected: string, provided: string): boolean {
  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');
  const maxLen = Math.max(expectedBuf.length, providedBuf.length);

  const paddedExpected = Buffer.alloc(maxLen);
  const paddedProvided = Buffer.alloc(maxLen);
  expectedBuf.copy(paddedExpected);
  providedBuf.copy(paddedProvided);

  return (
    expectedBuf.length === providedBuf.length &&
    crypto.timingSafeEqual(paddedExpected, paddedProvided)
  );
}

export function tokenAuthMiddleware(token: string): express.RequestHandler {
  return (req, _res, next) => {
    const authHeader = req.headers['authorization'];

    if (authHeader === undefined || !authHeader.startsWith('Bearer ')) {
      next(createAppError(401, 'Unauthorized', 'AUTH_REQUIRED'));
      return;
    }

    const provided = authHeader.slice('Bearer '.length);

    if (!timingSafeCompare(token, provided)) {
      next(createAppError(401, 'Unauthorized', 'AUTH_REQUIRED'));
      return;
    }

    req.user = { id: 'operator', name: 'Operator', email: undefined };
    next();
  };
}
