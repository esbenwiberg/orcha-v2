import { Router, type Request, type Response } from 'express';
import type { Eta } from 'eta';
import { eventBus } from '../services/event-bus.js';
import { issueTicket } from '../ws/ws-tickets.js';

export function createEventsRouter(eta: Eta): Router {
  const router = Router();

  // Issue a one-time WebSocket auth ticket (for OIDC mode where cookies aren't
  // available at the HTTP upgrade layer). This endpoint is protected by the
  // normal auth middleware; the ticket is passed as ?ticket= in the WS URL.
  router.get('/api/ws-ticket', (_req: Request, res: Response) => {
    res.json({ ticket: issueTicket() });
  });

  router.get('/api/events', (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const unsubscribe = eventBus.subscribe(async (event) => {
      // Always send the raw JSON event
      res.write(`data: ${JSON.stringify(event)}\n\n`);

      // For session status events, also send a named event with the badge HTML
      if (event.type === 'status' && 'sessionId' in event && event.status) {
        const badgeHtml = await eta.renderAsync('partials/status-badge', {
          status: event.status,
          sessionId: event.sessionId,
        });
        const eventName = `session-status-${event.sessionId}`;
        res.write(`event: ${eventName}\ndata: ${badgeHtml.replace(/\n/g, '')}\n\n`);
      }

      // For task status events, send a named event with the badge HTML
      if (event.type === 'task-status' && 'taskId' in event && event.status) {
        const _taskStatusMap: Record<string, string> = {
          draft: 'badge-neutral',
          investigating: 'badge-warning badge-dot badge-pulse',
          rejected: 'badge-error',
          enriching: 'badge-warning badge-dot badge-pulse',
          queued: 'badge-accent',
          executing: 'badge-info badge-dot badge-pulse',
          done: 'badge-success',
          failed: 'badge-error',
          cancelled: 'badge-neutral',
        };
        const cls = _taskStatusMap[event.status] || 'badge-neutral';
        const badgeHtml = `<span class="badge ${cls}" id="task-badge-${event.taskId}" sse-swap="task-status-${event.taskId}" hx-swap="outerHTML">${event.status}</span>`;
        const eventName = `task-status-${event.taskId}`;
        res.write(`event: ${eventName}\ndata: ${badgeHtml}\n\n`);
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
