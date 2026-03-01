import { Router } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { RepoStore } from '../db/repo-store.js';
import { PresetStore } from '../db/preset-store.js';
import { SessionStore } from '../db/session-store.js';
import { ValidationManager } from '../validation/validation-manager.js';

/**
 * Create an Express router that serves MCP over SSE for validation tools.
 * Each session gets its own SSE connection at /mcp/validate/:sessionId.
 */
export function createValidateMcpRouter(
  db: Database.Database,
  validationManager: ValidationManager,
): Router {
  const router = Router();
  const repoStore = new RepoStore(db);
  const presetStore = new PresetStore(db);
  const sessionStore = new SessionStore(db);

  // Track active transports by MCP session ID
  const transports = new Map<string, SSEServerTransport>();

  // GET /mcp/validate/:sessionId — establish SSE connection
  router.get('/mcp/validate/:sessionId', (req, res) => {
    const sessionId = req.params['sessionId'] ?? '';
    console.log(`[mcp] SSE connection for session ${sessionId}`);

    // Create a new MCP server instance per connection
    const mcpServer = buildMcpServer(sessionId, db, validationManager, repoStore, presetStore, sessionStore);

    // The SSE transport's message endpoint — relative to the SSE URL
    const transport = new SSEServerTransport(`/mcp/validate/${sessionId}/message`, res);

    transports.set(transport.sessionId, transport);

    transport.onclose = () => {
      transports.delete(transport.sessionId);
    };

    mcpServer.connect(transport).catch((err) => {
      console.error(`[mcp] failed to connect transport for session ${sessionId}:`, err);
    });
  });

  // POST /mcp/validate/:sessionId/message — receive MCP messages
  router.post('/mcp/validate/:sessionId/message', (req, res) => {
    const mcpSessionId = req.query['sessionId'] as string | undefined;
    if (!mcpSessionId) {
      res.status(400).send('Missing sessionId query param');
      return;
    }

    const transport = transports.get(mcpSessionId);
    if (!transport) {
      res.status(404).send('No active SSE session');
      return;
    }

    transport.handlePostMessage(req, res).catch((err) => {
      console.error('[mcp] error handling POST message:', err);
      if (!res.headersSent) {
        res.status(500).send('Internal error');
      }
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

  return mcp;
}
