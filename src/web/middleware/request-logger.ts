import type express from 'express';

export function requestLogger(): express.RequestHandler {
  return (req, res, next) => {
    const start = Date.now();

    res.on('finish', () => {
      const duration = Date.now() - start;
      const timestamp = new Date().toISOString();
      process.stderr.write(
        `[${timestamp}] ${req.method} ${req.path} ${res.statusCode} ${duration}ms\n`,
      );
    });

    next();
  };
}
