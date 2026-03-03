import { Router, type Request, type Response } from 'express';
import type { Eta } from 'eta';
import type { AppDeps } from '../app.js';
import { getStoragePaths } from '../../storage/paths.js';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { SessionStore } from '../../db/session-store.js';
import type { Deployer } from '../../deploy/deployer.js';
import type { DeployConfig } from '../../deploy/deploy-config.js';

function getDirSizeBytes(dirPath: string): number {
  try {
    if (!fs.existsSync(dirPath)) return 0;
    const output = execSync(`du -sb "${dirPath}" 2>/dev/null`, { encoding: 'utf8' });
    return parseInt(output.split('\t')[0] ?? '0', 10);
  } catch {
    return 0;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

function buildStats(deps: AppDeps, deployConfig: DeployConfig | null, deployer: Deployer | null) {
  const paths = getStoragePaths();

  let dbStatus = 'error';
  try {
    deps.db.prepare('SELECT 1').get();
    dbStatus = 'ok';
  } catch {}

  const worktreesBytes = getDirSizeBytes(paths.worktreeBaseDir);
  const bareReposBytes = getDirSizeBytes(paths.bareRepoDir);
  const logsBytes = getDirSizeBytes(paths.logsDir);
  const totalBytes = worktreesBytes + bareReposBytes + logsBytes;

  return {
    uptime: formatUptime(process.uptime()),
    dbStatus,
    nodeVersion: process.version,
    dataDir: paths.dataDir,
    disk: {
      total: { bytes: totalBytes, formatted: formatBytes(totalBytes) },
      worktrees: { bytes: worktreesBytes, formatted: formatBytes(worktreesBytes), path: paths.worktreeBaseDir },
      bareRepos: { bytes: bareReposBytes, formatted: formatBytes(bareReposBytes), path: paths.bareRepoDir },
      logs: { bytes: logsBytes, formatted: formatBytes(logsBytes), path: paths.logsDir },
    },
    ...(deployConfig
      ? {
          deploy: {
            configured: true,
            sourceRepo: deployConfig.sourceRepo,
            sourceBranch: deployConfig.sourceBranch,
            acrName: deployConfig.acrName,
            containerAppName: deployConfig.containerAppName,
            busy: deployer?.busy ?? false,
          },
        }
      : {}),
  };
}

export function createSystemRouter(
  eta: Eta,
  deps: AppDeps,
  deployer: Deployer | null = null,
  deployConfig: DeployConfig | null = null,
): Router {
  const router = Router();

  // GET /api/system/stats — render system stats partial
  router.get('/system/stats', (_req, res, next) => {
    try {
      const stats = buildStats(deps, deployConfig, deployer);
      const html = eta.render('partials/system-stats', stats);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/system/clean/logs — delete log files older than 7 days
  router.post('/system/clean/logs', (_req, res, next) => {
    try {
      const { logsDir } = getStoragePaths();
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;

      if (fs.existsSync(logsDir)) {
        for (const entry of fs.readdirSync(logsDir)) {
          const filePath = path.join(logsDir, entry);
          try {
            const stat = fs.statSync(filePath);
            if (stat.mtimeMs < cutoff) {
              fs.rmSync(filePath, { recursive: true, force: true });
            }
          } catch {
            // best-effort
          }
        }
      }

      const stats = buildStats(deps, deployConfig, deployer);
      const html = eta.render('partials/system-stats', stats);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/system/clean/worktrees — remove worktrees for stopped sessions
  router.post('/system/clean/worktrees', (_req, res, next) => {
    try {
      const { worktreeBaseDir } = getStoragePaths();
      const sessionStore = new SessionStore(deps.db);

      // Build set of session IDs that are still running or starting
      const activeSessions = new Set(
        sessionStore
          .listSessions()
          .filter((s) => s.status === 'running' || s.status === 'starting')
          .map((s) => s.id),
      );

      if (fs.existsSync(worktreeBaseDir)) {
        for (const entry of fs.readdirSync(worktreeBaseDir)) {
          // Skip directories belonging to active sessions
          if (activeSessions.has(entry)) continue;
          const dirPath = path.join(worktreeBaseDir, entry);
          try {
            const stat = fs.statSync(dirPath);
            if (stat.isDirectory()) {
              fs.rmSync(dirPath, { recursive: true, force: true });
            }
          } catch {
            // best-effort
          }
        }
      }

      const stats = buildStats(deps, deployConfig, deployer);
      const html = eta.render('partials/system-stats', stats);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // ── Deploy routes ─────────────────────────────────────────────────────────

  // POST /api/system/deploy — kick off a deploy, return log viewer partial
  router.post('/system/deploy', (_req, res, next) => {
    try {
      if (!deployer || !deployConfig) {
        res.status(404).send('Deploy not configured');
        return;
      }
      if (deployer.busy) {
        res.status(409).send('Deploy already in progress');
        return;
      }

      const tag = `deploy-${Date.now()}`;
      // Fire and forget — the deploy runs in the background
      deployer.deploy(tag).catch(() => {});

      const html = eta.render('partials/deploy-log', { tag });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/system/deploy/logs — SSE stream of deploy log entries
  router.get('/system/deploy/logs', (req: Request, res: Response) => {
    if (!deployer) {
      res.status(404).send('Deploy not configured');
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // Send catch-up logs
    const state = deployer.getState();
    for (const entry of state.logs) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }

    // Subscribe to new entries
    const unsubscribe = deployer.subscribe((entry) => {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
      if (typeof (res as unknown as { flush?: () => void }).flush === 'function') {
        (res as unknown as { flush: () => void }).flush();
      }
    });

    // Keepalive
    const keepalive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 25000);

    req.on('close', () => {
      unsubscribe();
      clearInterval(keepalive);
    });
  });

  // GET /api/system/deploy/status — JSON status for polling
  router.get('/system/deploy/status', (_req, res) => {
    if (!deployer) {
      res.status(404).json({ configured: false });
      return;
    }
    const state = deployer.getState();
    res.json({ phase: state.phase, busy: state.busy });
  });

  return router;
}
