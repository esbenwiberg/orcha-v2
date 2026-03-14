import { Router, type Request, type Response } from 'express';
import type { Eta } from 'eta';
import type { AppDeps } from '../app.js';
import { getStoragePaths } from '../../storage/paths.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { SessionStore } from '../../db/session-store.js';
import type { Deployer } from '../../deploy/deployer.js';
import type { DeployConfig } from '../../deploy/deploy-config.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function getDirSizeBytes(dirPath: string): Promise<number> {
  return new Promise((resolve) => {
    execFile('du', ['-sb', dirPath], { timeout: 30_000 }, (err, stdout) => {
      if (err) {
        resolve(0);
        return;
      }
      const bytes = parseInt(stdout.split('\t')[0] ?? '0', 10);
      resolve(Number.isNaN(bytes) ? 0 : bytes);
    });
  });
}

function getFileSizeBytes(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

/** Get filesystem capacity info for a path via `df` */
function getFilesystemInfo(dirPath: string): Promise<{ totalBytes: number; usedBytes: number; availBytes: number; usedPercent: number }> {
  return new Promise((resolve) => {
    execFile('df', ['-B1', '--output=size,used,avail,pcent', dirPath], { timeout: 10_000 }, (err, stdout) => {
      if (err) {
        resolve({ totalBytes: 0, usedBytes: 0, availBytes: 0, usedPercent: 0 });
        return;
      }
      // Skip header line, parse values
      const lines = stdout.trim().split('\n');
      const dataLine = lines[1]?.trim();
      if (!dataLine) {
        resolve({ totalBytes: 0, usedBytes: 0, availBytes: 0, usedPercent: 0 });
        return;
      }
      const parts = dataLine.split(/\s+/);
      const totalBytes = parseInt(parts[0] ?? '0', 10);
      const usedBytes = parseInt(parts[1] ?? '0', 10);
      const availBytes = parseInt(parts[2] ?? '0', 10);
      const usedPercent = parseInt((parts[3] ?? '0').replace('%', ''), 10);
      resolve({
        totalBytes: Number.isNaN(totalBytes) ? 0 : totalBytes,
        usedBytes: Number.isNaN(usedBytes) ? 0 : usedBytes,
        availBytes: Number.isNaN(availBytes) ? 0 : availBytes,
        usedPercent: Number.isNaN(usedPercent) ? 0 : usedPercent,
      });
    });
  });
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

// ── CPU usage tracking ───────────────────────────────────────────────────────

let prevCpuTimes: { idle: number; total: number } | null = null;

function getCpuTimes(): { idle: number; total: number } {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq + cpu.times.idle;
  }
  return { idle, total };
}

function getCpuUsagePercent(): number {
  const current = getCpuTimes();
  if (!prevCpuTimes) {
    prevCpuTimes = current;
    return 0;
  }
  const idleDelta = current.idle - prevCpuTimes.idle;
  const totalDelta = current.total - prevCpuTimes.total;
  prevCpuTimes = current;
  if (totalDelta === 0) return 0;
  return Math.round(((totalDelta - idleDelta) / totalDelta) * 100);
}

// Take an initial snapshot so the first real call has a delta
getCpuUsagePercent();

// ── Disk size cache (60s TTL, stale-while-revalidate) ────────────────────────

interface DiskCache {
  worktreesBytes: number;
  bareReposBytes: number;
  logsBytes: number;
  dbBytes: number;
  caddyBytes: number;
  filesystem: { totalBytes: number; usedBytes: number; availBytes: number; usedPercent: number };
  updatedAt: number;
}

const DISK_CACHE_TTL_MS = 60_000;
let diskCache: DiskCache | null = null;
let diskCacheRefreshing = false;

async function refreshDiskCache(): Promise<DiskCache> {
  const paths = getStoragePaths();
  const [worktreesBytes, bareReposBytes, logsBytes, caddyBytes, filesystem] = await Promise.all([
    getDirSizeBytes(paths.worktreeBaseDir),
    getDirSizeBytes(paths.bareRepoDir),
    getDirSizeBytes(paths.logsDir),
    getDirSizeBytes(paths.caddyDataDir),
    getFilesystemInfo(paths.dataDir),
  ]);
  const dbBytes = getFileSizeBytes(paths.dbPath);
  diskCache = { worktreesBytes, bareReposBytes, logsBytes, dbBytes, caddyBytes, filesystem, updatedAt: Date.now() };
  return diskCache;
}

async function getDiskSizes(): Promise<DiskCache> {
  if (!diskCache) {
    return refreshDiskCache();
  }
  if (Date.now() - diskCache.updatedAt < DISK_CACHE_TTL_MS) {
    return diskCache;
  }
  if (!diskCacheRefreshing) {
    diskCacheRefreshing = true;
    refreshDiskCache().finally(() => {
      diskCacheRefreshing = false;
    });
  }
  return diskCache;
}

// ── Router ───────────────────────────────────────────────────────────────────

export function createSystemRouter(
  eta: Eta,
  deps: AppDeps,
  deployer: Deployer | null = null,
  deployConfig: DeployConfig | null = null,
): Router {
  const router = Router();

  // GET /api/system/overview — instant stats (no disk I/O)
  router.get('/system/overview', (_req, res, next) => {
    try {
      const sessionStore = new SessionStore(deps.db);
      const sessions = sessionStore.listSessions();
      const activeSessions = sessions.filter((s) => s.status === 'running' || s.status === 'starting').length;
      const completedSessions = sessions.filter((s) => s.status === 'completed').length;
      const failedSessions = sessions.filter((s) => s.status === 'failed').length;

      let dbStatus = 'error';
      try {
        deps.db.prepare('SELECT 1').get();
        dbStatus = 'ok';
      } catch {}

      const html = eta.render('partials/system-overview', {
        uptime: formatUptime(process.uptime()),
        dbStatus,
        nodeVersion: process.version,
        environment: process.env['NODE_ENV'] ?? 'production',
        sandboxMode: process.env['SANDBOX_MODE'] ?? 'none',
        sessions: {
          total: sessions.length,
          active: activeSessions,
          completed: completedSessions,
          failed: failedSessions,
        },
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/system/resources — CPU + memory gauges (instant)
  router.get('/system/resources', (_req, res, next) => {
    try {
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const memPercent = Math.round((usedMem / totalMem) * 100);

      const procMem = process.memoryUsage();
      const procMemPercent = Math.round((procMem.rss / totalMem) * 100);

      const cpuPercent = getCpuUsagePercent();

      const html = eta.render('partials/system-resources', {
        cpu: {
          percent: cpuPercent,
          cores: os.cpus().length,
          model: os.cpus()[0]?.model ?? 'Unknown',
        },
        memory: {
          percent: memPercent,
          total: formatBytes(totalMem),
          used: formatBytes(usedMem),
          free: formatBytes(freeMem),
        },
        process: {
          rss: formatBytes(procMem.rss),
          heapUsed: formatBytes(procMem.heapUsed),
          heapTotal: formatBytes(procMem.heapTotal),
          percent: procMemPercent,
        },
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/system/disk — disk usage breakdown (slow, cached)
  router.get('/system/disk', async (_req, res, next) => {
    try {
      const disk = await getDiskSizes();
      const paths = getStoragePaths();
      const orchaTotal = disk.worktreesBytes + disk.bareReposBytes + disk.logsBytes + disk.dbBytes + disk.caddyBytes;

      const html = eta.render('partials/system-disk', {
        dataDir: paths.dataDir,
        filesystem: {
          ...disk.filesystem,
          totalFormatted: formatBytes(disk.filesystem.totalBytes),
          usedFormatted: formatBytes(disk.filesystem.usedBytes),
          availFormatted: formatBytes(disk.filesystem.availBytes),
        },
        orchaTotal: { bytes: orchaTotal, formatted: formatBytes(orchaTotal) },
        items: [
          { label: 'Worktrees', bytes: disk.worktreesBytes, formatted: formatBytes(disk.worktreesBytes), path: paths.worktreeBaseDir },
          { label: 'Bare repos', bytes: disk.bareReposBytes, formatted: formatBytes(disk.bareReposBytes), path: paths.bareRepoDir },
          { label: 'Logs', bytes: disk.logsBytes, formatted: formatBytes(disk.logsBytes), path: paths.logsDir },
          { label: 'Database', bytes: disk.dbBytes, formatted: formatBytes(disk.dbBytes), path: paths.dbPath },
          { label: 'Caddy data', bytes: disk.caddyBytes, formatted: formatBytes(disk.caddyBytes), path: paths.caddyDataDir },
        ],
        deploy: deployConfig
          ? {
              configured: true,
              sourceRepo: deployConfig.sourceRepo,
              sourceBranch: deployConfig.sourceBranch,
              acrName: deployConfig.acrName,
              containerAppName: deployConfig.containerAppName,
              busy: deployer?.busy ?? false,
            }
          : undefined,
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // Keep the old endpoint as an alias that returns all sections (used by cleanup actions)
  router.get('/system/stats', async (_req, res, next) => {
    try {
      const disk = await getDiskSizes();
      const paths = getStoragePaths();
      const orchaTotal = disk.worktreesBytes + disk.bareReposBytes + disk.logsBytes + disk.dbBytes + disk.caddyBytes;

      const html = eta.render('partials/system-disk', {
        dataDir: paths.dataDir,
        filesystem: {
          ...disk.filesystem,
          totalFormatted: formatBytes(disk.filesystem.totalBytes),
          usedFormatted: formatBytes(disk.filesystem.usedBytes),
          availFormatted: formatBytes(disk.filesystem.availBytes),
        },
        orchaTotal: { bytes: orchaTotal, formatted: formatBytes(orchaTotal) },
        items: [
          { label: 'Worktrees', bytes: disk.worktreesBytes, formatted: formatBytes(disk.worktreesBytes), path: paths.worktreeBaseDir },
          { label: 'Bare repos', bytes: disk.bareReposBytes, formatted: formatBytes(disk.bareReposBytes), path: paths.bareRepoDir },
          { label: 'Logs', bytes: disk.logsBytes, formatted: formatBytes(disk.logsBytes), path: paths.logsDir },
          { label: 'Database', bytes: disk.dbBytes, formatted: formatBytes(disk.dbBytes), path: paths.dbPath },
          { label: 'Caddy data', bytes: disk.caddyBytes, formatted: formatBytes(disk.caddyBytes), path: paths.caddyDataDir },
        ],
        deploy: deployConfig
          ? {
              configured: true,
              sourceRepo: deployConfig.sourceRepo,
              sourceBranch: deployConfig.sourceBranch,
              acrName: deployConfig.acrName,
              containerAppName: deployConfig.containerAppName,
              busy: deployer?.busy ?? false,
            }
          : undefined,
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/system/clean/logs — delete log files older than 7 days
  router.post('/system/clean/logs', async (_req, res, next) => {
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

      // Invalidate cache after cleanup, return fresh disk section
      diskCache = null;
      const disk = await getDiskSizes();
      const paths = getStoragePaths();
      const orchaTotal = disk.worktreesBytes + disk.bareReposBytes + disk.logsBytes + disk.dbBytes + disk.caddyBytes;

      const html = eta.render('partials/system-disk', {
        dataDir: paths.dataDir,
        filesystem: {
          ...disk.filesystem,
          totalFormatted: formatBytes(disk.filesystem.totalBytes),
          usedFormatted: formatBytes(disk.filesystem.usedBytes),
          availFormatted: formatBytes(disk.filesystem.availBytes),
        },
        orchaTotal: { bytes: orchaTotal, formatted: formatBytes(orchaTotal) },
        items: [
          { label: 'Worktrees', bytes: disk.worktreesBytes, formatted: formatBytes(disk.worktreesBytes), path: paths.worktreeBaseDir },
          { label: 'Bare repos', bytes: disk.bareReposBytes, formatted: formatBytes(disk.bareReposBytes), path: paths.bareRepoDir },
          { label: 'Logs', bytes: disk.logsBytes, formatted: formatBytes(disk.logsBytes), path: paths.logsDir },
          { label: 'Database', bytes: disk.dbBytes, formatted: formatBytes(disk.dbBytes), path: paths.dbPath },
          { label: 'Caddy data', bytes: disk.caddyBytes, formatted: formatBytes(disk.caddyBytes), path: paths.caddyDataDir },
        ],
        deploy: deployConfig
          ? {
              configured: true,
              sourceRepo: deployConfig.sourceRepo,
              sourceBranch: deployConfig.sourceBranch,
              acrName: deployConfig.acrName,
              containerAppName: deployConfig.containerAppName,
              busy: deployer?.busy ?? false,
            }
          : undefined,
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/system/clean/worktrees — remove worktrees for stopped sessions
  router.post('/system/clean/worktrees', async (_req, res, next) => {
    try {
      const { worktreeBaseDir } = getStoragePaths();
      const sessionStore = new SessionStore(deps.db);

      const activeSessions = new Set(
        sessionStore
          .listSessions()
          .filter((s) => s.status === 'running' || s.status === 'starting')
          .map((s) => s.id),
      );

      if (fs.existsSync(worktreeBaseDir)) {
        for (const entry of fs.readdirSync(worktreeBaseDir)) {
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

      // Invalidate cache after cleanup, return fresh disk section
      diskCache = null;
      const disk = await getDiskSizes();
      const paths = getStoragePaths();
      const orchaTotal = disk.worktreesBytes + disk.bareReposBytes + disk.logsBytes + disk.dbBytes + disk.caddyBytes;

      const html = eta.render('partials/system-disk', {
        dataDir: paths.dataDir,
        filesystem: {
          ...disk.filesystem,
          totalFormatted: formatBytes(disk.filesystem.totalBytes),
          usedFormatted: formatBytes(disk.filesystem.usedBytes),
          availFormatted: formatBytes(disk.filesystem.availBytes),
        },
        orchaTotal: { bytes: orchaTotal, formatted: formatBytes(orchaTotal) },
        items: [
          { label: 'Worktrees', bytes: disk.worktreesBytes, formatted: formatBytes(disk.worktreesBytes), path: paths.worktreeBaseDir },
          { label: 'Bare repos', bytes: disk.bareReposBytes, formatted: formatBytes(disk.bareReposBytes), path: paths.bareRepoDir },
          { label: 'Logs', bytes: disk.logsBytes, formatted: formatBytes(disk.logsBytes), path: paths.logsDir },
          { label: 'Database', bytes: disk.dbBytes, formatted: formatBytes(disk.dbBytes), path: paths.dbPath },
          { label: 'Caddy data', bytes: disk.caddyBytes, formatted: formatBytes(disk.caddyBytes), path: paths.caddyDataDir },
        ],
        deploy: deployConfig
          ? {
              configured: true,
              sourceRepo: deployConfig.sourceRepo,
              sourceBranch: deployConfig.sourceBranch,
              acrName: deployConfig.acrName,
              containerAppName: deployConfig.containerAppName,
              busy: deployer?.busy ?? false,
            }
          : undefined,
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // ── Deploy routes ─────────────────────────────────────────────────────────

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
      deployer.deploy(tag).catch(() => {});

      const html = eta.render('partials/deploy-log', { tag });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

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

    const state = deployer.getState();
    for (const entry of state.logs) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }

    const unsubscribe = deployer.subscribe((entry) => {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
      if (typeof (res as unknown as { flush?: () => void }).flush === 'function') {
        (res as unknown as { flush: () => void }).flush();
      }
    });

    const keepalive = setInterval(() => {
      res.write(': keepalive\n\n');
    }, 25000);

    req.on('close', () => {
      unsubscribe();
      clearInterval(keepalive);
    });
  });

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
