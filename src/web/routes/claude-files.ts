import { Router } from 'express';
import type { Eta } from 'eta';
import type Database from 'better-sqlite3';
import { GlobalSettingsStore } from '../../db/global-settings-store.js';
import type { SessionValidateConfig } from '../../domain/types.js';
import { fetchArchitectureContext, formatPrismContext } from '../../prism/client.js';
import type { PrismConfig } from '../../prism/client.js';

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

/**
 * Build a CLAUDE.md section describing the snapshotted validate config for this session.
 * Returns empty string if no validate config is present.
 */
export function buildValidateConfigSection(vc: SessionValidateConfig | undefined): string {
  if (!vc) return '';

  const lines: string[] = [];
  if (vc.validateMode) lines.push(`- **Mode**: ${vc.validateMode}`);
  if (vc.validateBuild) lines.push(`- **Build command**: \`${vc.validateBuild}\``);
  if (vc.validateStart) lines.push(`- **Start command**: \`${vc.validateStart}\``);
  if (vc.validateHealth) lines.push(`- **Health path**: \`${vc.validateHealth}\``);
  if (vc.validateHealthPort) lines.push(`- **Health port**: ${vc.validateHealthPort}`);
  if (vc.validateComposeFile) lines.push(`- **Compose file**: \`${vc.validateComposeFile}\``);
  if (vc.validateTimeout) lines.push(`- **Timeout**: ${vc.validateTimeout}s`);
  if (vc.validateReadyDelay) lines.push(`- **Ready delay**: ${vc.validateReadyDelay}s`);
  if (vc.validateEnv && Object.keys(vc.validateEnv).length > 0) {
    lines.push(`- **Env vars**: ${Object.entries(vc.validateEnv).map(([k, v]) => `\`${k}=${v}\``).join(', ')}`);
  }

  if (lines.length === 0) return '';

  return [
    '',
    '# Validation',
    '',
    'This repo has pre-configured validation defaults. When using `validate_start`, these are applied automatically -- you only need to override what is different.',
    'The app MUST bind to the port in `$PORT` (assigned automatically). Do NOT hardcode port numbers.',
    '',
    ...lines,
    '',
    'In most cases, call `validate_start` with no arguments and it will just work.',
    '',
  ].join('\n');
}

/**
 * Read Prism connection config from global settings.
 * Returns null if either URL or API key is missing.
 */
export function getPrismConfig(store: GlobalSettingsStore): PrismConfig | null {
  const url = store.get('prism.url');
  const apiKey = store.get('prism.api_key');
  if (!url || !apiKey) return null;
  return { url, apiKey };
}

/**
 * Fetch and format the Prism architecture overview for a repo.
 * Returns empty string if Prism is not configured, the repo has no slug,
 * or the fetch fails. Never throws.
 */
export async function buildPrismContextSection(
  store: GlobalSettingsStore,
  prismSlug: string | null,
): Promise<string> {
  if (!prismSlug) return '';
  const config = getPrismConfig(store);
  if (!config) return '';

  const response = await fetchArchitectureContext(config, prismSlug);
  return formatPrismContext(response);
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
