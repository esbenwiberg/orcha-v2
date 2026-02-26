import type express from 'express';
import type { ZodSchema } from 'zod';
import { createAppError } from '../errors.js';

/**
 * Returns an Express middleware that validates req.body against the given Zod schema.
 * On validation failure, collects all issues into a single message and calls next() with a 400 AppError.
 * On success, replaces req.body with the parsed (type-coerced) result.
 */
export function validateBody<T>(schema: ZodSchema<T>): express.RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const message = result.error.issues.map((issue) => issue.message).join('; ');
      next(createAppError(400, message, 'VALIDATION_ERROR'));
      return;
    }
    req.body = result.data as typeof req.body;
    next();
  };
}
