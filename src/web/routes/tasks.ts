import { Router } from 'express';
import type { Eta } from 'eta';
import type { AppDeps } from '../app.js';
import { TaskStore } from '../../db/task-store.js';
import { RepoStore } from '../../db/repo-store.js';
import { CredentialStore } from '../../db/credential-store.js';
import { ModelConfigStore } from '../../db/model-config-store.js';
import { McpServerStore } from '../../db/mcp-server-store.js';
import { credentialManager } from '../../credentials/credential-manager.js';
import { parsePrUrl, fetchPrStatus, fetchNewComments } from '../../tasks/github-pr.js';
import type { TaskStatus } from '../../domain/task-types.js';

export function createTasksRouter(eta: Eta, deps: AppDeps): Router {
  const router = Router();
  const taskStore = new TaskStore(deps.db);
  const repoStore = new RepoStore(deps.db);
  const credentialStore = new CredentialStore(deps.db);
  const modelConfigStore = new ModelConfigStore(deps.db);
  const mcpServerStore = new McpServerStore(deps.db);

  // GET /tasks — list all tasks (HTMX partial)
  router.get('/tasks', (req, res, next) => {
    try {
      const statusFilter = req.query['status'] as TaskStatus | undefined;
      const repoFilter = req.query['repoId'] as string | undefined;
      const tasks = taskStore.listTasks({
        ...(statusFilter ? { status: statusFilter } : {}),
        ...(repoFilter ? { repoId: repoFilter } : {}),
      });
      const repos = repoStore.listRepos();
      const html = eta.render('partials/task-list', { tasks, repos });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /tasks/new-form — render task creation form
  router.get('/tasks/new-form', (_req, res, next) => {
    try {
      const repos = repoStore.listRepos().filter((r) => r.status === 'ready');
      const credentialProfiles = credentialStore.listProfiles();
      const modelConfigs = modelConfigStore.listConfigs();
      const mcpServers = mcpServerStore.listServers();
      const html = eta.render('partials/new-task-form', {
        repos,
        credentialProfiles,
        modelConfigs,
        mcpServers,
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // POST /tasks — create a new task
  router.post('/tasks', (req, res, next) => {
    try {
      const { repoId, title, description, credentialProfileId, modelConfigId, branch } = req.body as Record<string, string>;
      const autoEnrich = req.body['autoEnrich'] === '1';
      const selfValidate = req.body['selfValidate'] === '1';
      const mcpServerIds = Array.isArray(req.body['mcpServerIds'])
        ? (req.body['mcpServerIds'] as string[])
        : req.body['mcpServerIds']
          ? [req.body['mcpServerIds'] as string]
          : [];

      if (!repoId || !title || !description) {
        const repos = repoStore.listRepos().filter((r) => r.status === 'ready');
        const credentialProfiles = credentialStore.listProfiles();
        const modelConfigs = modelConfigStore.listConfigs();
        const mcpServers = mcpServerStore.listServers();
        const html = eta.render('partials/form-error', {
          error: 'Repository, title, and description are required.',
          formPartial: 'new-task-form',
          formData: {
            repos,
            credentialProfiles,
            modelConfigs,
            mcpServers,
            repoId,
            title,
            description,
            autoEnrich,
            selfValidate,
            mcpServerIds,
            credentialProfileId,
            modelConfigId,
            branch,
          },
        });
        res.status(422).send(html);
        return;
      }

      taskStore.createTask({
        repoId,
        title,
        description,
        autoEnrich,
        selfValidate,
        mcpServerIds,
        ...(credentialProfileId ? { credentialProfileId } : {}),
        ...(modelConfigId ? { modelConfigId } : {}),
        ...(branch ? { branch } : {}),
      });

      res.setHeader('HX-Trigger-After-Swap', 'refresh-task-list');
      res.status(204).send('');
    } catch (err) {
      next(err);
    }
  });

  // GET /tasks/:id — task detail view
  router.get('/tasks/:id', (req, res, next) => {
    try {
      const task = taskStore.getTask(req.params['id']!);
      if (!task) {
        res.status(404).send('Task not found');
        return;
      }
      const repo = repoStore.getRepo(task.repoId);
      const transcript = {
        investigate: {
          count: taskStore.getTranscriptCount(task.id, 'investigate'),
        },
        enrich: {
          count: taskStore.getTranscriptCount(task.id, 'enrich'),
        },
        execute: {
          count: taskStore.getTranscriptCount(task.id, 'execute'),
        },
      };
      // Check if the execution session is still alive
      const sessionActive = task.sessionId
        ? deps.sessionEngine.getSessionByDbId(task.sessionId) !== undefined
        : false;
      const events = taskStore.getEvents(task.id);
      const html = eta.render('partials/task-detail', { task, repo, transcript, sessionActive, events });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /tasks/:id/transcript/:phase — transcript for a phase
  router.get('/tasks/:id/transcript/:phase', (req, res, next) => {
    try {
      const entries = taskStore.getTranscript(req.params['id']!, req.params['phase']!);
      const html = eta.render('partials/task-transcript', { entries, phase: req.params['phase']! });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // POST /tasks/:id/cancel
  router.post('/tasks/:id/cancel', (req, res, next) => {
    try {
      const task = taskStore.getTask(req.params['id']!);
      if (!task) {
        res.status(404).send('Task not found');
        return;
      }
      taskStore.transition(task.id, 'cancelled', 'Cancelled by user');

      // If there's an active execution session, stop it
      if (task.sessionId) {
        const session = deps.sessionEngine.getSessionByDbId(task.sessionId);
        if (session) {
          deps.sessionEngine.stopSession(session.sessionId).catch(() => {});
        }
      }

      res.setHeader('HX-Trigger-After-Swap', 'refresh-task-list');
      res.status(204).send('');
    } catch (err) {
      next(err);
    }
  });

  // POST /tasks/:id/retry — retry a failed task
  router.post('/tasks/:id/retry', (req, res, next) => {
    try {
      const task = taskStore.getTask(req.params['id']!);
      if (!task) {
        res.status(404).send('Task not found');
        return;
      }
      // Reset error and worktree path, re-enter the pipeline from the start
      taskStore.updateTask(task.id, { errorMessage: '' });
      taskStore.setWorktreePath(task.id, null);
      taskStore.transition(task.id, 'draft', 'Retried by user — restarting from draft');
      res.setHeader('HX-Trigger-After-Swap', 'refresh-task-list');
      res.status(204).send('');
    } catch (err) {
      next(err);
    }
  });

  // POST /tasks/:id/retry-execute — re-run execution only (keeps investigation/enrichment)
  router.post('/tasks/:id/retry-execute', (req, res, next) => {
    try {
      const task = taskStore.getTask(req.params['id']!);
      if (!task) {
        res.status(404).send('Task not found');
        return;
      }
      // Clear error but keep enrichment/investigation results and worktree
      taskStore.updateTask(task.id, { errorMessage: '' });
      taskStore.transition(task.id, 'queued', 'Retry execution only — skipping investigation/enrichment');
      res.setHeader('HX-Trigger-After-Swap', 'refresh-task-list');
      res.status(204).send('');
    } catch (err) {
      next(err);
    }
  });

  // POST /tasks/:id/force-enrich — override rejected → enriching
  router.post('/tasks/:id/force-enrich', (req, res, next) => {
    try {
      const task = taskStore.getTask(req.params['id']!);
      if (!task) {
        res.status(404).send('Task not found');
        return;
      }
      taskStore.transition(task.id, 'enriching', 'Force-enriched by user (overriding rejection)');
      res.setHeader('HX-Trigger-After-Swap', 'refresh-task-list');
      res.status(204).send('');
    } catch (err) {
      next(err);
    }
  });

  // POST /tasks/:id/force-queue — override rejected → queued
  router.post('/tasks/:id/force-queue', (req, res, next) => {
    try {
      const task = taskStore.getTask(req.params['id']!);
      if (!task) {
        res.status(404).send('Task not found');
        return;
      }
      taskStore.transition(task.id, 'queued', 'Force-queued by user (skipping enrichment)');
      res.setHeader('HX-Trigger-After-Swap', 'refresh-task-list');
      res.status(204).send('');
    } catch (err) {
      next(err);
    }
  });

  // POST /tasks/:id/mark-done — manually mark a failed task as done
  router.post('/tasks/:id/mark-done', (req, res, next) => {
    try {
      const task = taskStore.getTask(req.params['id']!);
      if (!task) {
        res.status(404).send('Task not found');
        return;
      }
      taskStore.updateTask(task.id, { errorMessage: '' });
      taskStore.transition(task.id, 'done', 'Manually marked done by user');
      res.setHeader('HX-Trigger-After-Swap', 'refresh-task-list');
      res.status(204).send('');
    } catch (err) {
      next(err);
    }
  });

  // POST /tasks/:id/check-pr — fetch PR status and new review comments
  router.post('/tasks/:id/check-pr', async (req, res, next) => {
    try {
      const task = taskStore.getTask(req.params['id']!);
      if (!task?.prUrl) {
        res.status(404).send('Task not found or no PR URL');
        return;
      }

      const pr = parsePrUrl(task.prUrl);
      if (!pr) {
        res.status(422).send('Could not parse PR URL');
        return;
      }

      // Provision a GitHub token from the credential profile
      let ghToken: string | undefined;
      if (task.credentialProfileId) {
        const profile = credentialStore.getProfile(task.credentialProfileId);
        if (profile) {
          const { env: credEnv } = await credentialManager.provision(profile);
          ghToken = credEnv['GH_TOKEN'] ?? credEnv['GITHUB_TOKEN'];
        }
      }
      // Fall back to ambient env
      ghToken ??= process.env['GH_TOKEN'] ?? process.env['GITHUB_TOKEN'];

      if (!ghToken) {
        res.status(422).send('<div class="text-xs text-red-400 p-2">No GitHub token available. Configure a credential profile with GitHub access.</div>');
        return;
      }

      // Use completedAt as default watermark (comments after initial execution)
      const since = task.prCommentWatermark ?? task.completedAt?.toISOString() ?? null;

      const [prStatus, comments] = await Promise.all([
        fetchPrStatus(pr, ghToken),
        fetchNewComments(pr, ghToken, since),
      ]);

      // Persist merged status so it shows in the task header without re-checking
      if (prStatus.merged && !task.prMerged) {
        taskStore.setPrMerged(task.id, true);
      }

      const html = eta.render('partials/task-pr-review', {
        taskId: task.id,
        prStatus,
        comments,
      });
      // Re-render the status badge via HX-Trigger so the header updates
      if (prStatus.merged && !task.prMerged) {
        res.setHeader('HX-Trigger-After-Swap', 'refresh-task-list');
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // POST /tasks/:id/address-feedback — re-queue execution with review feedback
  router.post('/tasks/:id/address-feedback', async (req, res, next) => {
    try {
      const task = taskStore.getTask(req.params['id']!);
      if (!task?.prUrl) {
        res.status(404).send('Task not found or no PR URL');
        return;
      }

      const pr = parsePrUrl(task.prUrl);
      if (!pr) {
        res.status(422).send('Could not parse PR URL');
        return;
      }

      // Provision token and fetch the comments we're about to address
      let ghToken: string | undefined;
      if (task.credentialProfileId) {
        const profile = credentialStore.getProfile(task.credentialProfileId);
        if (profile) {
          const { env: credEnv } = await credentialManager.provision(profile);
          ghToken = credEnv['GH_TOKEN'] ?? credEnv['GITHUB_TOKEN'];
        }
      }
      ghToken ??= process.env['GH_TOKEN'] ?? process.env['GITHUB_TOKEN'];

      if (!ghToken) {
        res.status(422).send('No GitHub token available');
        return;
      }

      const since = task.prCommentWatermark ?? task.completedAt?.toISOString() ?? null;
      const comments = await fetchNewComments(pr, ghToken, since);

      if (comments.length === 0) {
        res.status(422).send('<div class="text-xs text-slate-400 p-2">No new comments to address.</div>');
        return;
      }

      // Store feedback and update watermark
      const feedbackText = comments
        .map((c) => {
          const loc = c.path ? `[${c.path}] ` : '';
          return `${loc}${c.body}`;
        })
        .join('\n\n---\n\n');

      taskStore.setReviewFeedback(task.id, feedbackText);
      taskStore.setPrCommentWatermark(task.id, new Date().toISOString());
      taskStore.updateTask(task.id, { errorMessage: '' });
      taskStore.transition(task.id, 'queued', `Addressing ${comments.length} review comment(s)`);

      res.setHeader('HX-Trigger-After-Swap', 'refresh-task-list');
      res.status(204).send('');
    } catch (err) {
      next(err);
    }
  });

  // DELETE /tasks/:id
  router.delete('/tasks/:id', (req, res, next) => {
    try {
      taskStore.deleteTask(req.params['id']!);
      res.setHeader('HX-Trigger-After-Swap', 'refresh-task-list');
      res.status(204).send('');
    } catch (err) {
      next(err);
    }
  });

  return router;
}
