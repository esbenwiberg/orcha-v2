import { Router } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { SessionStore } from '../db/session-store.js';
import { ValidationManager } from '../validation/validation-manager.js';
import { resolveOrchaHost } from '../host-url.js';
import { eventBus } from '../web/services/event-bus.js';

/**
 * Create an Express router that serves MCP over Streamable HTTP for validation tools.
 * Each Orcha session gets its own endpoint at /mcp/validate/:sessionId.
 */
export function createValidateMcpRouter(
  db: Database.Database,
  validationManager: ValidationManager,
): Router {
  const router = Router();
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
    const mcpServer = buildMcpServer(orchaSessionId, validationManager, sessionStore);
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
  validationManager: ValidationManager,
  sessionStore: SessionStore,
): McpServer {
  const mcp = new McpServer(
    { name: 'orcha-validate', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  // --- validate_start ---
  mcp.tool(
    'validate_start',
    'Start a validation environment to test your app live. This is always the first step — call this before any other validate tool. ' +
    'It builds (optional), starts the app process, and polls a health endpoint until ready. ' +
    'Returns a preview URL the human user can also open in their browser. ' +
    'Most parameters have defaults configured on the repo/preset — only override what you need. ' +
    'Typical workflow: validate_start → validate_browse → validate_screenshot/validate_extract → validate_stop.',
    {
      mode: z.enum(['serve', 'docker']).optional().describe('Validation mode: "serve" (run a process) or "docker" (docker compose)'),
      build: z.string().optional().describe('Build command to run before starting (e.g. "npm run build")'),
      start: z.string().optional().describe('Start command for serve mode (e.g. "node dist/server.js")'),
      health: z.string().optional().describe('Health check path, e.g. "/health"'),
      health_port: z.number().optional().describe('Port to health-check on if different from the app port (for multi-process apps where backend and frontend run on separate ports)'),
      compose_file: z.string().optional().describe('Docker compose file path for docker mode'),
      timeout: z.number().optional().describe('Auto-stop timeout in seconds (default 300)'),
      ready_delay: z.number().optional().describe('Seconds to wait after health check passes before marking as healthy. Gives bundlers (esbuild/Vite) time to warm their cache before Playwright navigates. Default 0.'),
      env: z.record(z.string(), z.string()).optional().describe('Extra environment variables to inject into build and start commands (e.g. {"PATH": "/custom/sdk/bin:/usr/bin", "NODE_ENV": "development"})'),
    },
    async (args) => {
      try {
        // Look up session to get worktree path and snapshotted validation config
        const dbSession = sessionStore.getSession(sessionId);
        if (!dbSession) {
          return { content: [{ type: 'text' as const, text: `Session ${sessionId} not found in database` }], isError: true };
        }

        const worktreePath = dbSession.worktree.worktreePath;

        // Use the snapshotted validation config from the session (merged repo + preset at creation time).
        // This is deterministic — retries always use the same defaults regardless of later config edits.
        const vc = dbSession.config.validateConfig;
        const repoFields = vc ? {
          validateMode: vc.validateMode ?? null,
          validateBuild: vc.validateBuild ?? null,
          validateStart: vc.validateStart ?? null,
          validateHealth: vc.validateHealth ?? null,
          validateHealthPort: vc.validateHealthPort ?? null,
          validateComposeFile: vc.validateComposeFile ?? null,
          validateTimeout: vc.validateTimeout ?? null,
          validateReadyDelay: vc.validateReadyDelay ?? null,
          validateEnv: vc.validateEnv ?? {},
        } : undefined;

        const result = await validationManager.start(sessionId, {
          worktreePath,
          ...(repoFields ? { repoFields } : {}),
          agentOverrides: {
            ...(args.mode ? { mode: args.mode } : {}),
            ...(args.build ? { build: args.build } : {}),
            ...(args.start ? { start: args.start } : {}),
            ...(args.health ? { health: args.health } : {}),
            ...(args.health_port !== undefined ? { health_port: args.health_port } : {}),
            ...(args.compose_file ? { compose_file: args.compose_file } : {}),
            ...(args.timeout !== undefined ? { timeout: args.timeout } : {}),
            ...(args.ready_delay !== undefined ? { ready_delay: args.ready_delay } : {}),
            ...(args.env ? { env: args.env } : {}),
          },
        });

        const proxyPath = `/validate/${sessionId}/`;
        const orchaHost = resolveOrchaHost();
        const previewUrl = `${orchaHost}${proxyPath}`;
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              url: result.url,
              previewUrl,
              port: result.port,
              status: result.status,
              message: `Validation environment started. Preview: ${previewUrl}`,
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
    'Stop the running validation environment and free its port. ' +
    'Call this when you\'re done validating, or before restarting with different config. ' +
    'The environment also auto-stops after the configured timeout (default 300s).',
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
    'Check whether the validation environment is running, healthy, or errored. ' +
    'Returns the current status, port, and preview URL. Use this to verify readiness before browsing, ' +
    'or to diagnose why validate_browse is failing.',
    async () => {
      const result = validationManager.status(sessionId);
      if (!result) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ status: 'not_running', message: 'No validation environment is running for this session.' }) }],
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ...result, previewUrl: `${resolveOrchaHost()}/validate/${sessionId}/` }) }],
      };
    },
  );

  // --- validate_logs ---
  mcp.tool(
    'validate_logs',
    'Get recent server-side stdout/stderr output from the app process. ' +
    'Use this to check for startup errors, crash traces, or backend issues. ' +
    'For browser-side console logs (console.log, errors, warnings), use validate_console instead.',
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
    'Navigate to a page and take a screenshot. This is the primary tool for visually inspecting the running app. ' +
    'Returns a screenshot image, the page title, the final URL, and any console errors. ' +
    'Call this before using validate_screenshot, validate_extract, or validate_console — those tools operate on the page loaded by the most recent validate_browse call. ' +
    'Requires validate_start to have been called first.',
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
    'Take another screenshot of the current page without navigating. ' +
    'Use this to capture the full scrollable page (full_page=true) or a specific element by CSS selector — ' +
    'things validate_browse doesn\'t do by default. ' +
    'If you just need a standard viewport screenshot, validate_browse already returns one. ' +
    'Requires a prior validate_browse call to have loaded a page.',
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
    'Extract structured data from the current page using CSS selectors. ' +
    'Returns the text content of each matching element by default, or a specific HTML attribute (href, src, data-*, etc.) if specified. ' +
    'Use this when you need to assert on page content programmatically rather than visually. ' +
    'Requires a prior validate_browse call to have loaded a page.',
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

  // --- validate_handoff ---
  mcp.tool(
    'validate_handoff',
    'Hand the browser to the human user for tasks you can\'t do yourself — login, MFA, OAuth flows, CAPTCHAs, etc. ' +
    'Opens the given URL in a browser visible to the user through the Orcha UI, then blocks until they click Done ' +
    'or a wait_for CSS selector appears. The browser session persists after handoff, so you can continue using ' +
    'validate_browse and validate_screenshot on the now-authenticated page. ' +
    'Returns a screenshot of the final state. Requires validate_start to have been called first.',
    {
      url: z.string().describe('URL to navigate to before handing off (e.g. a Dataverse login page)'),
      message: z.string().optional().describe('Message shown to the user in the Orcha UI (e.g. "Please log in to Dataverse")'),
      proxy: z.string().optional().describe('HTTP proxy URL for the browser (e.g. "http://localhost:8642" for pcf-dev-proxy MITM)'),
      wait_for: z.string().optional().describe('CSS selector — auto-completes handoff when this element appears in the DOM'),
      timeout: z.number().optional().describe('Max seconds to wait for user interaction (default 300)'),
    },
    async (args) => {
      try {
        const dbSession = sessionStore.getSession(sessionId);
        if (!dbSession) {
          return { content: [{ type: 'text' as const, text: `Session ${sessionId} not found` }], isError: true };
        }

        if (!validationManager.has(sessionId)) {
          return {
            content: [{ type: 'text' as const, text: 'No validation environment running. Call validate_start first.' }],
            isError: true,
          };
        }

        // Notify UI that handoff is starting
        eventBus.publish({
          type: 'handoff',
          sessionId,
          status: 'started',
          url: args.url,
          ...(args.message !== undefined ? { message: args.message } : {}),
        });

        const result = await validationManager.handoff(sessionId, args.url, {
          ...(args.message !== undefined ? { message: args.message } : {}),
          ...(args.proxy !== undefined ? { proxy: args.proxy } : {}),
          ...(args.wait_for !== undefined ? { waitFor: args.wait_for } : {}),
          ...(args.timeout !== undefined ? { timeout: args.timeout } : {}),
        });

        // Notify UI that handoff completed
        eventBus.publish({ type: 'handoff', sessionId, status: 'completed' });

        const orchaHost = resolveOrchaHost();
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                status: 'completed',
                url: result.url,
                title: result.title,
                message: `Handoff completed. Browser is authenticated at ${result.url}. You can now use validate_browse and validate_screenshot.`,
              }),
            },
            {
              type: 'image' as const,
              data: result.screenshot.toString('base64'),
              mimeType: 'image/png' as const,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Handoff failed: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // --- validate_console ---
  mcp.tool(
    'validate_console',
    'Get browser-side console logs (console.log, console.error, warnings, exceptions) captured since the last validate_browse navigation. ' +
    'Use this to debug client-side JavaScript issues. For server-side stdout/stderr, use validate_logs instead. ' +
    'Requires a prior validate_browse call to have loaded a page.',
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
