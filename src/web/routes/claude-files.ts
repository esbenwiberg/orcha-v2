import { Router } from 'express';
import type { Eta } from 'eta';
import type Database from 'better-sqlite3';
import { GlobalSettingsStore } from '../../db/global-settings-store.js';

/** Whitelist of allowed DB keys → filenames written into ~/.claude/ */
const ALLOWED_FILES: Record<string, string> = {
  claude_md: 'CLAUDE.md',
  soul_md: 'soul.md',
};

export function getClaudeFileContent(store: GlobalSettingsStore, key: string): string {
  return store.get(key) ?? '';
}

/**
 * Build the merged CLAUDE.md content for a session's ~/.claude/CLAUDE.md.
 * Inlines soul.md content directly so it's auto-loaded by Claude Code
 * (soul.md is NOT a natively recognised file — it would only be read if
 * Claude decides to open it, which is unreliable).
 */
export function buildSessionClaudeMd(store: GlobalSettingsStore): string {
  const claudeMd = (store.get('claude_md') ?? '').trim();
  const soulMd = (store.get('soul_md') ?? '').trim();
  if (!claudeMd && !soulMd) return '';
  if (!soulMd) return claudeMd;
  if (!claudeMd) return `# Soul\n\n${soulMd}`;
  return `${claudeMd}\n\n# Soul\n\n${soulMd}`;
}

export function createClaudeFilesRouter(eta: Eta, db: Database.Database): Router {
  const router = Router();
  const settingsStore = new GlobalSettingsStore(db);

  // GET /api/claude-files/:key — render the editor partial
  router.get('/claude-files/:key', (req, res, next) => {
    try {
      const key = req.params['key'] ?? '';
      const filename = ALLOWED_FILES[key];
      if (!filename) {
        res.status(404).send('Not found');
        return;
      }

      const content = getClaudeFileContent(settingsStore, key);
      const html = eta.render('partials/claude-file-editor', { key, filename, content });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/claude-files/:key — save content
  router.post('/claude-files/:key', (req, res, next) => {
    try {
      const key = req.params['key'] ?? '';
      const filename = ALLOWED_FILES[key];
      if (!filename) {
        res.status(404).send('Not found');
        return;
      }

      const content = typeof req.body['content'] === 'string' ? req.body['content'] : '';

      if (content.trim().length === 0) {
        settingsStore.delete(key);
      } else {
        settingsStore.set(key, content);
      }

      const html = eta.render('partials/claude-file-editor', {
        key,
        filename,
        content: content.trim().length === 0 ? '' : content,
        saved: true,
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
