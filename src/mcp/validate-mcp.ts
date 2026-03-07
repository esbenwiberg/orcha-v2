import { Router } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { RepoStore } from '../db/repo-store.js';
import { PresetStore } from '../db/preset-store.js';
import { SessionStore } from '../db/session-store.js';
import { ValidationManager } from '../validation/validation-manager.js';

/**
 * Create an Express router that serves MCP over Streamable HTTP for validation tools.
 * Each Orcha session gets its own endpoint at /mcp/validate/:sessionId.
 */
export function createValidateMcpRouter(
  db: Database.Database,
  validationManager: ValidationManager,
): Router {
  const router = Router();
  const repoStore = new RepoStore(db);
  const presetStore = new PresetStore(db);
  const sessionStore = new SessionStore(db);

  // Track active transports per Orcha session → MCP session
  const transports = new Map<string, Map<string, StreamableHTTPServerTransport>>();

  function getOrCreateTransport(
    orchaSessionId: string,
    mcpSessionId: string | undefined,
  ): StreamableHTTPServerTransport | undefined {
    const sessionTransports = transports.get(orchaSessionId);

    // If we have a specific MCP session ID, look it up
    if (mcpSessionId && sessionTransports?.has(mcpSessionId)) {
      return sessionTransports.get(mcpSessionId);
    }

    // Only create new transports when no MCP session ID is provided (initialization)
    if (mcpSessionId) return undefined;

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (newSessionId) => {
        let map = transports.get(orchaSessionId);
        if (!map) {
          map = new Map();
          transports.set(orchaSessionId, map);
        }
        map.set(newSessionId, transport);
        console.log(`[mcp] streamable session initialized orchaSession=${orchaSessionId} mcpSession=${newSessionId}`);
      },
    });

    transport.onclose = () => {
      const map = transports.get(orchaSessionId);
      if (map) {
        for (const [k, v] of map) {
          if (v === transport) map.delete(k);
        }
        if (map.size === 0) transports.delete(orchaSessionId);
      }
    };

    // Connect an MCP server to this transport
    const mcpServer = buildMcpServer(orchaSessionId, db, validationManager, repoStore, presetStore, sessionStore);
    // Cast needed: StreamableHTTPServerTransport's onclose is optional but Transport requires it.
    // The MCP SDK types are slightly misaligned under exactOptionalPropertyTypes.
    mcpServer.connect(transport as Parameters<typeof mcpServer.connect>[0]).catch((err) => {
      console.error(`[mcp] failed to connect transport for session ${orchaSessionId}:`, err);
    });

    return transport;
  }

  // POST /mcp/validate/:sessionId — main Streamable HTTP endpoint (initialize + messages)
  router.post('/mcp/validate/:sessionId', (req, res) => {
    const orchaSessionId = req.params['sessionId'] ?? '';
    const mcpSessionId = req.headers['mcp-session-id'] as string | undefined;

    const transport = getOrCreateTransport(orchaSessionId, mcpSessionId);
    if (!transport) {
      res.status(400).json({ error: 'Bad Request: no active MCP session' });
      return;
    }

    transport.handleRequest(req, res).catch((err) => {
      console.error(`[mcp] error handling POST for session ${orchaSessionId}:`, err);
      if (!res.headersSent) res.status(500).send('Internal error');
    });
  });

  // GET /mcp/validate/:sessionId — SSE stream for server-initiated messages
  router.get('/mcp/validate/:sessionId', (req, res) => {
    const orchaSessionId = req.params['sessionId'] ?? '';
    const mcpSessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!mcpSessionId) {
      res.status(400).json({ error: 'Bad Request: Mcp-Session-Id header required for GET' });
      return;
    }

    const sessionTransports = transports.get(orchaSessionId);
    const transport = sessionTransports?.get(mcpSessionId);
    if (!transport) {
      res.status(404).json({ error: 'No active MCP session' });
      return;
    }

    transport.handleRequest(req, res).catch((err) => {
      console.error(`[mcp] error handling GET SSE for session ${orchaSessionId}:`, err);
      if (!res.headersSent) res.status(500).send('Internal error');
    });
  });

  // DELETE /mcp/validate/:sessionId — close MCP session
  router.delete('/mcp/validate/:sessionId', (req, res) => {
    const orchaSessionId = req.params['sessionId'] ?? '';
    const mcpSessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!mcpSessionId) {
      res.status(400).json({ error: 'Bad Request: Mcp-Session-Id header required for DELETE' });
      return;
    }

    const sessionTransports = transports.get(orchaSessionId);
    const transport = sessionTransports?.get(mcpSessionId);
    if (!transport) {
      res.status(404).json({ error: 'No active MCP session' });
      return;
    }

    transport.handleRequest(req, res).catch((err) => {
      console.error(`[mcp] error handling DELETE for session ${orchaSessionId}:`, err);
      if (!res.headersSent) res.status(500).send('Internal error');
    });
  });

  return router;
}

function buildMcpServer(
  sessionId: string,
  db: Database.Database,
  validationManager: ValidationManager,
  repoStore: RepoStore,
  presetStore: PresetStore,
  sessionStore: SessionStore,
): McpServer {
  const mcp = new McpServer(
    { name: 'orcha-validate', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  // --- validate_start ---
  mcp.tool(
    'validate_start',
    'Start a validation environment for this session. Builds (optional), spawns the app, and polls health.',
    {
      mode: z.enum(['serve', 'docker']).optional().describe('Validation mode: "serve" (run a process) or "docker" (docker compose)'),
      build: z.string().optional().describe('Build command to run before starting (e.g. "npm run build")'),
      start: z.string().optional().describe('Start command for serve mode (e.g. "node dist/server.js")'),
      health: z.string().optional().describe('Health check path, e.g. "/health"'),
      compose_file: z.string().optional().describe('Docker compose file path for docker mode'),
      timeout: z.number().optional().describe('Auto-stop timeout in seconds (default 300)'),
    },
    async (args) => {
      try {
        // Look up session to get worktree path and repo ID
        const dbSession = sessionStore.getSession(sessionId);
        if (!dbSession) {
          return { content: [{ type: 'text' as const, text: `Session ${sessionId} not found in database` }], isError: true };
        }

        const worktreePath = dbSession.worktree.worktreePath;

        // Get repo fields for config resolution
        // We need to find the repo by matching the worktree path back to a bare repo.
        // The session config has repoRoot which maps to the bare repo path.
        const repos = repoStore.listRepos();
        const repo = repos.find((r) => {
          if (!r.barePath) return false;
          return worktreePath.includes(r.barePath.replace(/\.git$/, ''));
        });

        const result = await validationManager.start(sessionId, {
          worktreePath,
          ...(repo ? {
            repoFields: {
              validateMode: repo.validateMode,
              validateBuild: repo.validateBuild,
              validateStart: repo.validateStart,
              validateHealth: repo.validateHealth,
              validateComposeFile: repo.validateComposeFile,
              validateTimeout: repo.validateTimeout,
            },
          } : {}),
          agentOverrides: {
            ...(args.mode ? { mode: args.mode } : {}),
            ...(args.build ? { build: args.build } : {}),
            ...(args.start ? { start: args.start } : {}),
            ...(args.health ? { health: args.health } : {}),
            ...(args.compose_file ? { compose_file: args.compose_file } : {}),
            ...(args.timeout !== undefined ? { timeout: args.timeout } : {}),
          },
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              url: result.url,
              port: result.port,
              status: result.status,
              message: `Validation environment started. Access at ${result.url}`,
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to start validation: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // --- validate_stop ---
  mcp.tool(
    'validate_stop',
    'Stop the running validation environment for this session.',
    async () => {
      try {
        const result = await validationManager.stop(sessionId);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to stop validation: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // --- validate_status ---
  mcp.tool(
    'validate_status',
    'Get the current status of the validation environment.',
    async () => {
      const result = validationManager.status(sessionId);
      if (!result) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ status: 'not_running', message: 'No validation environment is running for this session.' }) }],
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    },
  );

  // --- validate_logs ---
  mcp.tool(
    'validate_logs',
    'Get recent output logs from the validation environment.',
    {
      lines: z.number().optional().describe('Number of lines to return (default 50)'),
    },
    async (args) => {
      const lines = validationManager.logs(sessionId, args.lines ?? 50);
      return {
        content: [{ type: 'text' as const, text: lines.length > 0 ? lines.join('\n') : '(no output)' }],
      };
    },
  );

  // --- validate_browse ---
  mcp.tool(
    'validate_browse',
    'Navigate to a page in the validation app and return a screenshot, page title, and any console errors. Use this to visually inspect the running app.',
    {
      path: z.string().optional().describe('Path to navigate to, e.g. "/dashboard". Defaults to "/"'),
      url: z.string().optional().describe('Full URL to navigate to. Must be on localhost:{validationPort}. Overrides path.'),
      wait_for: z.string().optional().describe('CSS selector to wait for before taking the screenshot (10s timeout)'),
    },
    async (args) => {
      try {
        const result = await validationManager.browse(sessionId, {
          ...(args.path !== undefined ? { path: args.path } : {}),
          ...(args.url !== undefined ? { url: args.url } : {}),
          ...(args.wait_for !== undefined ? { waitFor: args.wait_for } : {}),
        });

        const metadata = {
          title: result.title,
          url: result.url,
          consoleErrors: result.consoleErrors,
        };

        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(metadata, null, 2) },
            {
              type: 'image' as const,
              data: result.screenshot.toString('base64'),
              mimeType: 'image/png' as const,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Browse failed: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // --- validate_screenshot ---
  mcp.tool(
    'validate_screenshot',
    'Take a screenshot of the current page or a specific element. Requires a prior validate_browse call.',
    {
      full_page: z.boolean().optional().describe('Capture the full scrollable page (default: viewport only)'),
      selector: z.string().optional().describe('CSS selector of a specific element to screenshot'),
    },
    async (args) => {
      try {
        const buf = await validationManager.screenshot(sessionId, {
          ...(args.full_page !== undefined ? { fullPage: args.full_page } : {}),
          ...(args.selector !== undefined ? { selector: args.selector } : {}),
        });

        return {
          content: [
            {
              type: 'image' as const,
              data: buf.toString('base64'),
              mimeType: 'image/png' as const,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Screenshot failed: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // --- validate_extract ---
  mcp.tool(
    'validate_extract',
    'Extract text, HTML, or an attribute from elements matching a CSS selector on the current page. Requires a prior validate_browse call.',
    {
      selector: z.string().describe('CSS selector to match elements'),
      attribute: z.string().optional().describe('HTML attribute to extract from each element (e.g. "href", "src")'),
    },
    async (args) => {
      try {
        const results = await validationManager.extract(
          sessionId,
          args.selector,
          args.attribute,
        );

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              selector: args.selector,
              count: results.length,
              results,
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Extract failed: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // --- validate_console ---
  mcp.tool(
    'validate_console',
    'Return buffered browser console logs from the validation app. Requires a prior validate_browse call.',
    {
      limit: z.number().optional().describe('Max number of entries to return (default: all, max 200)'),
    },
    async (args) => {
      const logs = validationManager.consoleLogs(sessionId, args.limit);
      return {
        content: [{
          type: 'text' as const,
          text: logs.length > 0
            ? JSON.stringify(logs, null, 2)
            : '(no console logs captured — navigate to a page with validate_browse first)',
        }],
      };
    },
  );

  return mcp;
}
