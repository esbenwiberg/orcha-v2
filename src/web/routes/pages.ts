import { Router } from 'express';

export function createPagesRouter(): Router {
  const router = Router();

  // GET / — root page stub; real templates will be wired in Phase 4
  router.get('/', (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.status(200).send('<html><body><h1>Orcha</h1></body></html>');
  });

  return router;
}
