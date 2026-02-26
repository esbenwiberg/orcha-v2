import { Router } from 'express';
import type { Eta } from 'eta';

export function createDashboardRouter(eta: Eta): Router {
  const router = Router();

  // GET / — dashboard with session grid
  router.get('/', (_req, res, next) => {
    try {
      const body = eta.render('dashboard', {});
      const html = eta.render('layout', {
        title: 'Orcha – Sessions',
        pageTitle: 'Sessions',
        activeNav: 'sessions',
        body,
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
