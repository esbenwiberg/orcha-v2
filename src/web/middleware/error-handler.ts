import type express from 'express';
import { isAppError } from '../errors.js';

export function errorHandler(): express.ErrorRequestHandler {
  // Four-argument signature is required for Express to recognise this as an error handler.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (err, _req, res, _next) => {
    if (isAppError(err)) {
      res.status(err.statusCode).json({
        error: {
          code: err.code ?? 'ERROR',
          message: err.message,
        },
      });
      return;
    }

    process.stderr.write(`[error] Unexpected error: ${String(err)}\n`);
    if (err instanceof Error && err.stack !== undefined) {
      process.stderr.write(err.stack + '\n');
    }

    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred',
      },
    });
  };
}
