import type express from 'express';

export function noAuthMiddleware(): express.RequestHandler {
  return (req, _res, next) => {
    req.user = { id: 'local', name: 'Local User', email: undefined };
    next();
  };
}
