import type express from 'express';
import { isAppError } from '../errors.js';

function isHtmxRequest(req: express.Request): boolean {
  return req.headers['hx-request'] === 'true';
}

export function errorHandler(): express.ErrorRequestHandler {
  // Four-argument signature is required for Express to recognise this as an error handler.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (err, req, res, _next) => {
    if (isAppError(err)) {
      if (isHtmxRequest(req)) {
        res
          .status(err.statusCode)
          .setHeader('Content-Type', 'text/html; charset=utf-8')
          .send(`<div class="badge badge--failed">${err.message}</div>`);
      } else {
        res.status(err.statusCode).json({
          error: {
            code: err.code ?? 'ERROR',
            message: err.message,
          },
        });
      }
      return;
    }

    process.stderr.write(`[error] Unexpected error: ${String(err)}\n`);
    if (err instanceof Error && err.stack !== undefined) {
      process.stderr.write(err.stack + '\n');
    }

    if (isHtmxRequest(req)) {
      res
        .status(500)
        .setHeader('Content-Type', 'text/html; charset=utf-8')
        .send('<div class="badge badge--failed">An unexpected error occurred</div>');
    } else {
      res.status(500).json({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred',
        },
      });
    }
  };
}
