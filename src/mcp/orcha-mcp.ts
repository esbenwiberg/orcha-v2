import { Router } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { TaskStore } from '../db/task-store.js';
import { RepoStore } from '../db/repo-store.js';
import { SessionStore } from '../db/session-store.js';

/**
 * Create an Express router that serves the Orcha MCP over Streamable HTTP.
 * Exposes task management tools so agents can log issues they discover mid-session.
 * Global endpoint at /mcp/orcha (not per-session) — any session can use it.
 */
export function createOrchaMcpRouter(db: Database.Database): Router {
  const router = Router();
  const taskStore = new TaskStore(db);
  const repoStore = new RepoStore(db);
  const sessionStore = new SessionStore(db);

  // Track active MCP transports by MCP session ID
  const transports = new Map<string, StreamableHTTPServerTransport>();

  function getOrCreateTransport(
    mcpSessionId: string | undefined,
  ): StreamableHTTPServerTransport | undefined {
    if (mcpSessionId && transports.has(mcpSessionId)) {
      return transports.get(mcpSessionId);
    }

    // Only create new transports when no MCP session ID is provided (initialization)
    if (mcpSessionId) return undefined;

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (newSessionId) => {
        transports.set(newSessionId, transport);
        console.log(`[mcp:orcha] session initialized mcpSession=${newSessionId}`);
      },
    });

    transport.onclose = () => {
      for (const [k, v] of transports) {
        if (v === transport) transports.delete(k);
      }
    };

    const mcpServer = buildMcpServer(db, taskStore, repoStore, sessionStore);
    mcpServer.connect(transport as Parameters<typeof mcpServer.connect>[0]).catch((err) => {
      console.error('[mcp:orcha] failed to connect transport:', err);
    });

    return transport;
  }

  // POST /mcp/orcha — main Streamable HTTP endpoint
  router.post('/mcp/orcha', (req, res) => {
    const mcpSessionId = req.headers['mcp-session-id'] as string | undefined;

    const transport = getOrCreateTransport(mcpSessionId);
    if (!transport) {
      res.status(400).json({ error: 'Bad Request: no active MCP session' });
      return;
    }

    transport.handleRequest(req, res).catch((err) => {
      console.error('[mcp:orcha] error handling POST:', err);
      if (!res.headersSent) res.status(500).send('Internal error');
    });
  });

  // GET /mcp/orcha — SSE stream for server-initiated messages
  router.get('/mcp/orcha', (req, res) => {
    const mcpSessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!mcpSessionId) {
      res.status(400).json({ error: 'Bad Request: Mcp-Session-Id header required for GET' });
      return;
    }

    const transport = transports.get(mcpSessionId);
    if (!transport) {
      res.status(404).json({ error: 'No active MCP session' });
      return;
    }

    transport.handleRequest(req, res).catch((err) => {
      console.error('[mcp:orcha] error handling GET SSE:', err);
      if (!res.headersSent) res.status(500).send('Internal error');
    });
  });

  // DELETE /mcp/orcha — close MCP session
  router.delete('/mcp/orcha', (req, res) => {
    const mcpSessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!mcpSessionId) {
      res.status(400).json({ error: 'Bad Request: Mcp-Session-Id header required for DELETE' });
      return;
    }

    const transport = transports.get(mcpSessionId);
    if (!transport) {
      res.status(404).json({ error: 'No active MCP session' });
      return;
    }

    transport.handleRequest(req, res).catch((err) => {
      console.error('[mcp:orcha] error handling DELETE:', err);
      if (!res.headersSent) res.status(500).send('Internal error');
    });
  });

  return router;
}

function buildMcpServer(
  _db: Database.Database,
  taskStore: TaskStore,
  repoStore: RepoStore,
  sessionStore: SessionStore,
): McpServer {
  const mcp = new McpServer(
    { name: 'orcha', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  // --- create_task ---
  mcp.tool(
    'create_task',
    `Log an issue you discovered while working on something else. Use this for bugs, tech debt, or improvements ` +
    `that are outside the scope of your current task — do NOT use it for work you're actively doing. ` +
    `Be specific: include what you observed, why it matters, and reproduction steps if applicable. ` +
    `The task lands in Orcha's kanban board as a draft for triage. ` +
    `Call list_tasks first to check for duplicates before creating.`,
    {
      title: z.string().max(200).describe('Short, descriptive title for the issue (e.g. "Login form crashes on empty email")'),
      description: z.string().describe('What you observed, why it matters, and any reproduction steps or context. Be specific.'),
      repo_name: z.string().optional().describe(
        'Name of the repo this issue belongs to (e.g. "my-app"). ' +
        'If omitted, tries to detect from the current Orcha session.',
      ),
      session_id: z.string().optional().describe(
        'Your current Orcha session ID. Used to auto-detect the repo if repo_name is not provided. ' +
        'Check the ORCHA_SESSION_ID environment variable.',
      ),
    },
    async (args) => {
      try {
        // Resolve repo ID
        let repoId: string | undefined;

        if (args.repo_name) {
          const repos = repoStore.listRepos();
          const match = repos.find(
            (r) => r.displayName.toLowerCase() === args.repo_name!.toLowerCase(),
          );
          if (!match) {
            const available = repos.map((r) => r.displayName).join(', ');
            return {
              content: [{
                type: 'text' as const,
                text: `Repo "${args.repo_name}" not found. Available repos: ${available || '(none)'}`,
              }],
              isError: true,
            };
          }
          repoId = match.id;
        }

        // Try session-based detection if no repo_name
        if (!repoId && args.session_id) {
          const session = sessionStore.getSession(args.session_id);
          if (session) {
            const repo = repoStore.getRepoByBarePath(session.config.repoRoot);
            if (repo) repoId = repo.id;
          }
        }

        if (!repoId) {
          const repos = repoStore.listRepos();
          const available = repos.map((r) => r.displayName).join(', ');
          return {
            content: [{
              type: 'text' as const,
              text: `Could not determine which repo this task belongs to. ` +
                `Provide repo_name or session_id. Available repos: ${available || '(none)'}`,
            }],
            isError: true,
          };
        }

        // Check for duplicates (rough title match)
        const existing = taskStore.listTasks({ repoId });
        const lowerTitle = args.title.toLowerCase().trim();
        const duplicate = existing.find(
          (t) => t.status !== 'done' && t.status !== 'cancelled' &&
            t.title.toLowerCase().trim() === lowerTitle,
        );
        if (duplicate) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                warning: 'A task with an identical title already exists',
                existingTask: {
                  id: duplicate.displayId,
                  title: duplicate.title,
                  status: duplicate.status,
                },
              }),
            }],
          };
        }

        const task = taskStore.createTask({
          repoId,
          title: args.title,
          description: args.description,
        });

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              created: true,
              taskId: task.displayId,
              title: task.title,
              status: task.status,
              message: `Task #${task.displayId} created. It will appear on the Orcha kanban board for triage.`,
            }),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to create task: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // --- list_tasks ---
  mcp.tool(
    'list_tasks',
    'List tasks from the Orcha kanban board. Use this to check for duplicates before calling create_task, ' +
    'or to see what work is queued/in-progress for a repo. ' +
    'Filter by repo_name and/or status. Returns up to 20 tasks by default, most recent first.',
    {
      repo_name: z.string().optional().describe('Filter by repo name'),
      status: z.enum(['draft', 'investigating', 'rejected', 'enriching', 'queued', 'executing', 'done', 'failed', 'cancelled']).optional().describe('Filter by status'),
      limit: z.number().optional().describe('Max tasks to return (default 20)'),
    },
    async (args) => {
      try {
        let repoId: string | undefined;
        if (args.repo_name) {
          const repos = repoStore.listRepos();
          const match = repos.find(
            (r) => r.displayName.toLowerCase() === args.repo_name!.toLowerCase(),
          );
          if (match) repoId = match.id;
        }

        const tasks = taskStore.listTasks({
          ...(repoId ? { repoId } : {}),
          ...(args.status ? { status: args.status } : {}),
        });

        const limit = args.limit ?? 20;
        const sliced = tasks.slice(0, limit);

        // Resolve repo names for display
        const repos = repoStore.listRepos();
        const repoMap = new Map(repos.map((r) => [r.id, r.displayName]));

        const result = sliced.map((t) => ({
          id: t.displayId,
          title: t.title,
          status: t.status,
          repo: repoMap.get(t.repoId) ?? t.repoId,
          createdAt: t.createdAt.toISOString(),
          ...(t.branch ? { branch: t.branch } : {}),
          ...(t.prUrl ? { prUrl: t.prUrl } : {}),
        }));

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              total: tasks.length,
              showing: sliced.length,
              tasks: result,
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to list tasks: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );

  return mcp;
}
