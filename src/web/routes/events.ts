import { Router, type Request, type Response } from 'express';
import type { Eta } from 'eta';
import { eventBus } from '../services/event-bus.js';

export function createEventsRouter(eta: Eta): Router {
  const router = Router();

  router.get('/api/events', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const unsubscribe = eventBus.subscribe(async (event) => {
      // Always send the raw JSON event
      res.write(`data: ${JSON.stringify(event)}\n\n`);

      // For status events, also send a named event with the badge HTML
      if (event.type === 'status' && event.status) {
        const badgeHtml = await eta.renderAsync('partials/status-badge', {
          status: event.status,
          sessionId: event.sessionId,
        });
        const eventName = `session-status-${event.sessionId}`;
        res.write(`event: ${eventName}\ndata: ${badgeHtml.replace(/\n/g, '')}\n\n`);
      }

      // Flush if the method exists (some middleware adds it)
      if (typeof (res as unknown as { flush?: () => void }).flush === 'function') {
        (res as unknown as { flush: () => void }).flush();
      }
    });

    // Keepalive every 25 seconds
    const keepalive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 25000);

    req.on('close', () => {
      unsubscribe();
      clearInterval(keepalive);
    });
  });

  return router;
}
