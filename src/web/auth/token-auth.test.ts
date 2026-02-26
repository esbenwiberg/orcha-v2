import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { tokenAuthMiddleware } from './token-auth.js';

function makeReq(authHeader?: string): Request {
  return {
    headers: authHeader !== undefined ? { authorization: authHeader } : {},
  } as unknown as Request;
}

const mockRes = {} as Response;

describe('tokenAuthMiddleware', () => {
  const SECRET = 'super-secret-token';
  const middleware = tokenAuthMiddleware(SECRET);

  it('returns 401 when Authorization header is missing', () => {
    const next = vi.fn();
    middleware(makeReq(), mockRes, next);

    expect(next).toHaveBeenCalledOnce();
    const err = next.mock.calls[0]?.[0] as { statusCode: number; code: string } | undefined;
    expect(err).toBeDefined();
    expect(err?.statusCode).toBe(401);
    expect(err?.code).toBe('AUTH_REQUIRED');
  });

  it('returns 401 when Authorization header is not Bearer scheme', () => {
    const next = vi.fn();
    middleware(makeReq('Basic dXNlcjpwYXNz'), mockRes, next);

    expect(next).toHaveBeenCalledOnce();
    const err = next.mock.calls[0]?.[0] as { statusCode: number; code: string } | undefined;
    expect(err).toBeDefined();
    expect(err?.statusCode).toBe(401);
    expect(err?.code).toBe('AUTH_REQUIRED');
  });

  it('returns 401 when Bearer token does not match', () => {
    const next = vi.fn();
    middleware(makeReq('Bearer wrong-token'), mockRes, next);

    expect(next).toHaveBeenCalledOnce();
    const err = next.mock.calls[0]?.[0] as { statusCode: number; code: string } | undefined;
    expect(err).toBeDefined();
    expect(err?.statusCode).toBe(401);
    expect(err?.code).toBe('AUTH_REQUIRED');
  });

  it('sets req.user and calls next() without error when token is correct', () => {
    const next = vi.fn();
    const req = makeReq(`Bearer ${SECRET}`);
    middleware(req, mockRes, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith();
    expect(req.user).toEqual({ id: 'operator', name: 'Operator', email: undefined });
  });
});
