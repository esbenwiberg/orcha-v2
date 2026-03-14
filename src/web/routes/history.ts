import { Router } from 'express';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Eta } from 'eta';
import type { AppDeps } from '../app.js';
import { SessionStore } from '../../db/session-store.js';
import { RepoStore } from '../../db/repo-store.js';
import { GlobalSettingsStore } from '../../db/global-settings-store.js';
import { ModelConfigStore } from '../../db/model-config-store.js';
import { getStoragePaths } from '../../storage/paths.js';
import { captureSessionHistory, type HistoryMeta } from '../../history/capture.js';
import { prepareAdminWorkspace } from '../../history/admin-workspace.js';
import { buildModelEnv, ENV_DELETE } from '../../model-config/env-builder.js';
import { formatRelativeTime } from '../views/helpers.js';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Scan session-history dir on disk to find sessions that have captured history. */
function getHistoryOnDisk(dataDir: string): Map<string, { sizeBytes: number; fileCount: number; meta?: HistoryMeta }> {
  const baseDir = join(dataDir, 'session-history');
  const result = new Map<string, { sizeBytes: number; fileCount: number; meta?: HistoryMeta }>();
  if (!existsSync(baseDir)) return result;

  for (const sessionId of readdirSync(baseDir)) {
    const sessionDir = join(baseDir, sessionId);
    try {
      const stat = statSync(sessionDir);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    let sizeBytes = 0;
    let fileCount = 0;
    // Walk one level of subdirs
    try {
      for (const subdir of readdirSync(sessionDir)) {
        const subdirPath = join(sessionDir, subdir);
        try {
          const subdirStat = statSync(subdirPath);
          if (subdirStat.isDirectory()) {
            for (const file of readdirSync(subdirPath)) {
              if (file.endsWith('.jsonl')) {
                const fileStat = statSync(join(subdirPath, file));
                sizeBytes += fileStat.size;
                fileCount++;
              }
            }
          } else if (subdir.endsWith('.jsonl')) {
            sizeBytes += subdirStat.size;
            fileCount++;
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }

    if (fileCount > 0) {
      let meta: HistoryMeta | undefined;
      try {
        const metaPath = join(sessionDir, 'meta.json');
        if (existsSync(metaPath)) {
          meta = JSON.parse(readFileSync(metaPath, 'utf8')) as HistoryMeta;
        }
      } catch { /* ignore corrupt meta */ }
      result.set(sessionId, { sizeBytes, fileCount, ...(meta !== undefined ? { meta } : {}) });
    }
  }

  return result;
}

export function createHistoryRouter(eta: Eta, deps: AppDeps): Router {
  const router = Router();
  const store = new SessionStore(deps.db);
  const repoStore = new RepoStore(deps.db);
  const globalSettings = new GlobalSettingsStore(deps.db);
  const modelConfigStore = new ModelConfigStore(deps.db);

  // GET /api/history/list — render history list partial
  router.get('/history/list', (_req, res, next) => {
    try {
      const { dataDir } = getStoragePaths();
      const diskInfo = getHistoryOnDisk(dataDir);

      // Build repo name lookup
      const repoNameMap = new Map<string, string>();
      for (const repo of repoStore.listRepos()) {
        if (repo.barePath !== null) {
          repoNameMap.set(repo.barePath, repo.displayName);
        }
      }

      // Merge DB sessions (for metadata) with on-disk history
      const sessions = store.listSessions();
      const sessionMap = new Map(sessions.map((s) => [s.id, s]));

      interface HistoryItem {
        sessionId: string;
        displayId: number | null;
        repoName: string;
        branch: string;
        capturedAt: string;
        messageCount: number;
        sizeFormatted: string;
        sizeBytes: number;
        status: string;
      }

      const items: HistoryItem[] = [];

      // Start with on-disk entries (authoritative)
      for (const [sessionId, disk] of diskInfo) {
        const session = sessionMap.get(sessionId);
        const meta = disk.meta;
        items.push({
          sessionId,
          displayId: session?.displayId ?? null,
          repoName: session
            ? (repoNameMap.get(session.config.repoRoot) ?? session.config.repoRoot.split('/').pop() ?? 'unknown')
            : (meta?.repoName ?? 'unknown'),
          branch: session?.worktree.branch ?? meta?.branch ?? 'unknown',
          capturedAt: session?.historyCapturedAt
            ? formatRelativeTime(session.historyCapturedAt)
            : (meta?.capturedAt ? formatRelativeTime(new Date(meta.capturedAt)) : 'on disk'),
          messageCount: session?.historyMessageCount ?? meta?.messageCount ?? 0,
          sizeFormatted: formatBytes(disk.sizeBytes),
          sizeBytes: disk.sizeBytes,
          status: session?.status ?? 'deleted',
        });
      }

      // Sort by most recent first (sessions with higher displayId are newer)
      items.sort((a, b) => (b.displayId ?? 0) - (a.displayId ?? 0));

      const totalBytes = items.reduce((sum, i) => sum + i.sizeBytes, 0);

      const modelConfigs = modelConfigStore.listConfigs();

      const html = eta.render('partials/history-list', {
        items,
        totalFormatted: formatBytes(totalBytes),
        count: items.length,
        modelConfigs,
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/history/:sessionId — render detail view
  router.get('/history/:sessionId', (req, res, next) => {
    try {
      const sessionId = req.params['sessionId'] ?? '';
      const { dataDir } = getStoragePaths();
      const historyDir = join(dataDir, 'session-history', sessionId);

      if (!existsSync(historyDir)) {
        res.status(404).send('<div class="text-muted">No history found for this session.</div>');
        return;
      }

      // Collect JSONL files
      interface HistoryFile {
        relPath: string;
        absPath: string;
        sizeFormatted: string;
        lineCount: number;
        preview: string[];
      }

      const files: HistoryFile[] = [];

      for (const subdir of readdirSync(historyDir)) {
        const subdirPath = join(historyDir, subdir);
        try {
          const stat = statSync(subdirPath);
          if (!stat.isDirectory()) continue;
          for (const file of readdirSync(subdirPath)) {
            if (!file.endsWith('.jsonl')) continue;
            const absPath = join(subdirPath, file);
            const fileStat = statSync(absPath);
            const content = readFileSync(absPath, 'utf8');
            const lines = content.split('\n').filter((l) => l.trim().length > 0);

            // Preview: first 5 messages, summarized
            const preview: string[] = [];
            for (const line of lines.slice(0, 5)) {
              try {
                const obj = JSON.parse(line) as Record<string, unknown>;
                const type = (obj['type'] as string) ?? 'unknown';
                const msg = obj['message'] as Record<string, unknown> | undefined;
                const role = msg?.['role'] as string | undefined;
                preview.push(`${role ?? type}: ${JSON.stringify(line).slice(0, 120)}...`);
              } catch {
                preview.push(line.slice(0, 120) + '...');
              }
            }

            files.push({
              relPath: `${subdir}/${file}`,
              absPath,
              sizeFormatted: formatBytes(fileStat.size),
              lineCount: lines.length,
              preview,
            });
          }
        } catch { /* skip */ }
      }

      const session = store.getSession(sessionId);
      const html = eta.render('partials/history-detail', {
        sessionId,
        displayId: session?.displayId ?? null,
        branch: session?.worktree.branch ?? 'unknown',
        files,
        totalMessages: files.reduce((sum, f) => sum + f.lineCount, 0),
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/history/:sessionId/download — serve JSONL files concatenated
  router.get('/history/:sessionId/download', (req, res, next) => {
    try {
      const sessionId = req.params['sessionId'] ?? '';
      const { dataDir } = getStoragePaths();
      const historyDir = join(dataDir, 'session-history', sessionId);

      if (!existsSync(historyDir)) {
        res.status(404).send('No history found');
        return;
      }

      const chunks: Buffer[] = [];
      for (const subdir of readdirSync(historyDir)) {
        const subdirPath = join(historyDir, subdir);
        try {
          const stat = statSync(subdirPath);
          if (!stat.isDirectory()) continue;
          for (const file of readdirSync(subdirPath)) {
            if (!file.endsWith('.jsonl')) continue;
            chunks.push(readFileSync(join(subdirPath, file)));
          }
        } catch { /* skip */ }
      }

      const combined = Buffer.concat(chunks);
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Content-Disposition', `attachment; filename="history-${sessionId}.jsonl"`);
      res.status(200).send(combined);
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/history/:sessionId — delete history files from disk
  router.delete('/history/:sessionId', (req, res, next) => {
    try {
      const sessionId = req.params['sessionId'] ?? '';
      const { dataDir } = getStoragePaths();
      const historyDir = join(dataDir, 'session-history', sessionId);

      if (existsSync(historyDir)) {
        rmSync(historyDir, { recursive: true, force: true });
      }

      // Clear DB columns if the session still exists
      try {
        const session = store.getSession(sessionId);
        if (session?.historyCapturedAt) {
          store.updateHistory(sessionId, { capturedAt: '', sizeBytes: 0, messageCount: 0 });
        }
      } catch { /* session may be deleted */ }

      res.status(200).send('');
    } catch (err) {
      next(err);
    }
  });

  // POST /api/history/clean — delete history older than N days
  router.post('/history/clean', (req, res, next) => {
    try {
      const days = parseInt(req.body['days'] as string, 10) || 30;
      const { dataDir } = getStoragePaths();
      const baseDir = join(dataDir, 'session-history');
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      let cleaned = 0;

      if (existsSync(baseDir)) {
        for (const sessionId of readdirSync(baseDir)) {
          const sessionDir = join(baseDir, sessionId);
          try {
            const stat = statSync(sessionDir);
            if (stat.isDirectory() && stat.mtimeMs < cutoff) {
              rmSync(sessionDir, { recursive: true, force: true });
              cleaned++;
            }
          } catch { /* skip */ }
        }
      }

      // Re-render the list
      res.setHeader('HX-Trigger', 'refresh-history');
      res.status(200).send(`<div class="text-muted">Cleaned ${cleaned} session(s) older than ${days} days.</div>`);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/history/capture/:sessionId — manually trigger history capture
  router.post('/history/capture/:sessionId', (req, res, next) => {
    try {
      const sessionId = req.params['sessionId'] ?? '';
      const session = store.getSession(sessionId);
      if (!session) {
        res.status(404).send('Session not found');
        return;
      }

      const { dataDir } = getStoragePaths();
      // Derive homeDir from session env or convention
      const homeDir = session.config.env?.['HOME'] ?? join('/tmp', `orcha-home-${sessionId}`);

      if (!existsSync(homeDir)) {
        res.status(422).send('<div class="text-muted">Session HOME directory not found — history may have already been cleaned up.</div>');
        return;
      }

      // Resolve repo display name for durable metadata
      const repo = repoStore.listRepos().find((r) => r.barePath === session.config.repoRoot);
      const repoName = repo?.displayName ?? session.config.repoRoot.split('/').pop() ?? 'unknown';
      const result = captureSessionHistory(sessionId, homeDir, dataDir, {
        repoName,
        branch: session.worktree.branch,
      });
      if (result) {
        store.updateHistory(sessionId, result);
        res.setHeader('HX-Trigger', 'refresh-history');
        res.status(200).send(`<div class="text-muted">Captured ${result.messageCount} messages (${formatBytes(result.sizeBytes)}).</div>`);
      } else {
        res.status(200).send('<div class="text-muted">No JSONL history files found in session HOME.</div>');
      }
    } catch (err) {
      next(err);
    }
  });

  // POST /api/history/admin-session — create an admin analysis session
  router.post('/history/admin-session', async (req, res, next) => {
    try {
      const { dataDir } = getStoragePaths();
      const selectedIds = req.body['sessionIds'] as string[] | undefined;
      const modelConfigId = (typeof req.body['modelConfigId'] === 'string' ? req.body['modelConfigId'] : '').trim();

      const { workspaceDir, homeDir } = prepareAdminWorkspace(
        dataDir,
        globalSettings,
        selectedIds?.length ? selectedIds : undefined,
      );

      // Build model config env vars and credentials if selected
      let modelEnv: Record<string, string> | undefined;
      let modelDeleteEnv: string[] | undefined;
      let modelProvider: string | undefined;
      if (modelConfigId) {
        const modelConfig = modelConfigStore.getConfig(modelConfigId);
        if (modelConfig) {
          modelProvider = modelConfig.provider;
          const envMap = buildModelEnv(modelConfig);
          const setEnv: Record<string, string> = {};
          const delEnv: string[] = [];
          for (const [key, value] of Object.entries(envMap)) {
            if (value === ENV_DELETE) {
              delEnv.push(key);
            } else {
              setEnv[key] = value;
            }
          }
          if (Object.keys(setEnv).length > 0) modelEnv = setEnv;
          if (delEnv.length > 0) modelDeleteEnv = delEnv;

          // Inject stored credentials (e.g. Max/Pro OAuth tokens)
          if (modelConfig.credentialsJson) {
            const claudeDir = join(homeDir, '.claude');
            mkdirSync(claudeDir, { recursive: true });
            writeFileSync(join(claudeDir, '.credentials.json'), modelConfig.credentialsJson, 'utf8');
          }
        }
      }

      await deps.sessionEngine.createAdminSession({
        workspaceDir,
        homeDir,
        prompt: 'You have access to Claude Code session history files in the ./history/ directory. Browse the available data and wait for instructions on what to analyze.',
        ...(modelEnv !== undefined ? { env: modelEnv } : {}),
        ...(modelDeleteEnv !== undefined ? { deleteEnv: modelDeleteEnv } : {}),
        ...(modelConfigId ? { modelConfigId } : {}),
        ...(modelProvider !== undefined ? { modelProvider } : {}),
      });

      // Redirect to the sessions page where the admin session card will appear
      res.setHeader('HX-Redirect', '/');
      res.status(200).send('');
    } catch (err) {
      next(err);
    }
  });

  return router;
}
