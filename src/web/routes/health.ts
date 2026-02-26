import { Router } from 'express';
import type Database from 'better-sqlite3';
import { getStoragePaths } from '../../storage/paths.js';

export function createHealthRouter(db: Database.Database): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    try {
      const { dataDir } = getStoragePaths();

      // SQLite round-trip is the primary liveness signal.
      db.prepare('SELECT 1').get();

      res.status(200).json({
        status: 'ok',
        uptime: process.uptime(),
        db: 'ok',
        dataDir,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      res.status(503).json({ status: 'error', reason });
    }
  });

  return router;
}
