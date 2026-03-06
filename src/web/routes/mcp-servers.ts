import { Router } from 'express';
import type { Eta } from 'eta';
import type Database from 'better-sqlite3';
import { McpServerStore } from '../../db/mcp-server-store.js';

const VALID_TYPES = new Set(['url', 'sse', 'command']);

export function createMcpServersRouter(eta: Eta, db: Database.Database): Router {
  const router = Router();
  const store = new McpServerStore(db);

  function renderPanel(res: import('express').Response): void {
    const servers = store.listServers();
    const html = eta.render('partials/mcp-servers-panel', { servers });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(html);
  }

  // GET /api/mcp-servers — render the panel partial
  router.get('/mcp-servers', (_req, res, next) => {
    try {
      renderPanel(res);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/mcp-servers — add a new MCP server
  router.post('/mcp-servers', (req, res, next) => {
    try {
      const name = (typeof req.body['name'] === 'string' ? req.body['name'] : '').trim();
      const type = (typeof req.body['type'] === 'string' ? req.body['type'] : '').trim();

      if (!name) {
        res.status(422).send('<div class="badge badge--failed">Name is required</div>');
        return;
      }
      if (!VALID_TYPES.has(type)) {
        res.status(422).send('<div class="badge badge--failed">Invalid server type</div>');
        return;
      }
      if (store.getServerByName(name)) {
        res.status(422).send('<div class="badge badge--failed">A server with that name already exists</div>');
        return;
      }

      if (type === 'url' || type === 'sse') {
        const url = (typeof req.body['url'] === 'string' ? req.body['url'] : '').trim();
        if (!url) {
          res.status(422).send('<div class="badge badge--failed">URL is required</div>');
          return;
        }

        // Parse optional headers (key: value per line)
        const headersRaw = (
          typeof req.body['headers'] === 'string' ? req.body['headers'] : ''
        ).trim();
        let headers: Record<string, string> | undefined;
        if (headersRaw) {
          headers = {};
          for (const line of headersRaw.split('\n')) {
            const idx = line.indexOf(':');
            if (idx > 0) {
              const key = line.slice(0, idx).trim().replace(/^["']|["']$/g, '');
              const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
              if (key) headers[key] = val;
            }
          }
          if (Object.keys(headers).length === 0) headers = undefined;
        }

        store.createServer({ name, type, url, ...(headers ? { headers } : {}) });
      } else {
        // command type
        const command = (
          typeof req.body['command'] === 'string' ? req.body['command'] : ''
        ).trim();
        if (!command) {
          res.status(422).send('<div class="badge badge--failed">Command is required</div>');
          return;
        }

        const argsRaw = (
          typeof req.body['args'] === 'string' ? req.body['args'] : ''
        ).trim();
        const args = argsRaw ? argsRaw.split('\n').map((a) => a.trim()).filter(Boolean) : undefined;

        store.createServer({ name, type, command, ...(args ? { args } : {}) });
      }

      renderPanel(res);
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/mcp-servers/:id — remove an MCP server
  router.delete('/mcp-servers/:id', (req, res, next) => {
    try {
      const id = req.params['id'] ?? '';
      store.deleteServer(id);
      renderPanel(res);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
