import { Router } from 'express';
import type { Eta } from 'eta';
import { readSettings, writeSettings, enqueueWrite } from './claude-settings-io.js';
import type { McpServerEntry } from './claude-settings-io.js';

/** Names that are auto-injected and should not be shown or touched by the user. */
const HIDDEN_SERVERS = new Set(['validate']);

const VALID_TYPES = new Set(['url', 'sse', 'command']);

function visibleServers(
  servers: Record<string, McpServerEntry> | undefined,
): { name: string; entry: McpServerEntry }[] {
  if (!servers) return [];
  return Object.entries(servers)
    .filter(([name]) => !HIDDEN_SERVERS.has(name))
    .map(([name, entry]) => ({ name, entry }));
}

function serverType(entry: McpServerEntry): string {
  if (entry.type) return entry.type;
  if (entry.command) return 'command';
  if (entry.url) return 'url';
  return 'unknown';
}

function serverEndpoint(entry: McpServerEntry): string {
  if (entry.url) return entry.url;
  if (entry.command) {
    const args = entry.args ? ' ' + entry.args.join(' ') : '';
    return entry.command + args;
  }
  return '';
}

export function createMcpServersRouter(eta: Eta): Router {
  const router = Router();

  function renderPanel(res: import('express').Response): void {
    const settings = readSettings();
    const servers = visibleServers(settings.mcpServers);
    const html = eta.render('partials/mcp-servers-panel', {
      servers,
      serverType,
      serverEndpoint,
    });
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
  router.post('/mcp-servers', async (req, res, next) => {
    try {
      const name = (typeof req.body['name'] === 'string' ? req.body['name'] : '').trim();
      const type = (typeof req.body['type'] === 'string' ? req.body['type'] : '').trim();

      if (!name) {
        res.status(422).send('<div class="badge badge--failed">Name is required</div>');
        return;
      }
      if (HIDDEN_SERVERS.has(name)) {
        res
          .status(422)
          .send(`<div class="badge badge--failed">"${name}" is a reserved name</div>`);
        return;
      }
      if (!VALID_TYPES.has(type)) {
        res.status(422).send('<div class="badge badge--failed">Invalid server type</div>');
        return;
      }

      let entry: McpServerEntry;

      if (type === 'url' || type === 'sse') {
        const url = (typeof req.body['url'] === 'string' ? req.body['url'] : '').trim();
        if (!url) {
          res.status(422).send('<div class="badge badge--failed">URL is required</div>');
          return;
        }
        entry = { type, url };

        // Parse optional headers (key: value per line)
        const headersRaw = (
          typeof req.body['headers'] === 'string' ? req.body['headers'] : ''
        ).trim();
        if (headersRaw) {
          const headers: Record<string, string> = {};
          for (const line of headersRaw.split('\n')) {
            const idx = line.indexOf(':');
            if (idx > 0) {
              const key = line.slice(0, idx).trim();
              const val = line.slice(idx + 1).trim();
              if (key) headers[key] = val;
            }
          }
          if (Object.keys(headers).length > 0) {
            entry.headers = headers;
          }
        }
      } else {
        // command type
        const command = (
          typeof req.body['command'] === 'string' ? req.body['command'] : ''
        ).trim();
        if (!command) {
          res.status(422).send('<div class="badge badge--failed">Command is required</div>');
          return;
        }
        entry = { type, command };

        const argsRaw = (
          typeof req.body['args'] === 'string' ? req.body['args'] : ''
        ).trim();
        if (argsRaw) {
          entry.args = argsRaw.split('\n').map((a) => a.trim()).filter(Boolean);
        }
      }

      await enqueueWrite(() => {
        const settings = readSettings();
        const mcpServers = settings.mcpServers ?? {};
        mcpServers[name] = entry;
        settings.mcpServers = mcpServers;
        writeSettings(settings);
      });

      renderPanel(res);
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/mcp-servers/:name — remove an MCP server
  router.delete('/mcp-servers/:name', async (req, res, next) => {
    try {
      const name = decodeURIComponent(req.params['name'] ?? '');

      if (HIDDEN_SERVERS.has(name)) {
        res.status(422).send('<div class="badge badge--failed">Cannot remove reserved server</div>');
        return;
      }

      await enqueueWrite(() => {
        const settings = readSettings();
        if (settings.mcpServers) {
          delete settings.mcpServers[name];
          if (Object.keys(settings.mcpServers).length === 0) {
            delete settings.mcpServers;
          }
          writeSettings(settings);
        }
      });

      renderPanel(res);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
