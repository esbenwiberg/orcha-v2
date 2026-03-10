import type { Request, Response, NextFunction } from 'express';
import { syncDbNow } from '../../db/db-sync.js';

/**
 * Express middleware that triggers an immediate DB sync to persistent storage
 * after any successful POST/PUT/DELETE response. This ensures critical mutations
 * (create/update/delete on presets, repos, tasks, etc.) survive OOM kills and
 * container restarts without waiting for the 30-second sync interval.
 *
 * The sync runs in the `finish` event — after the response is fully sent to
 * the client — so it doesn't add latency to the user-facing response.
 */
export function dbSyncMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
      res.on('finish', () => {
        // Only sync on success (2xx). Skip validation errors (422), not-found (404), etc.
        if (res.statusCode >= 200 && res.statusCode < 300) {
          syncDbNow();
        }
      });
    }
    next();
  };
}
