import { Router } from 'express';
import type { Eta } from 'eta';
import { GlobalSettingsStore } from '../../db/global-settings-store.js';
import type Database from 'better-sqlite3';

const DEVOPS_KEY = 'devops_bootstrap_pat';

/** Quick validation: hit the VSSPS tokens list endpoint to verify the PAT has token management scope. */
async function validateDevOpsPat(pat: string): Promise<{ ok: boolean; reason?: string }> {
  const base64 = Buffer.from(`:${pat}`).toString('base64');

  // 1. Profile check — verifies the PAT is valid at all
  const profileResp = await fetch(
    'https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1',
    { headers: { Authorization: `Basic ${base64}`, 'User-Agent': 'orcha/1.0' } },
  );
  if (!profileResp.ok) {
    return { ok: false, reason: `PAT rejected (${profileResp.status}). Check that the PAT is valid and not expired.` };
  }

  // 2. Token list check — verifies Token Administration scope
  const tokensResp = await fetch(
    'https://vssps.dev.azure.com/_apis/tokens/pats?api-version=7.1-preview.1',
    { headers: { Authorization: `Basic ${base64}`, 'User-Agent': 'orcha/1.0' } },
  );
  if (!tokensResp.ok) {
    return { ok: false, reason: `PAT is valid but lacks Token Administration scope (${tokensResp.status}). Add "Token Administration → Read & manage" to the PAT.` };
  }

  return { ok: true };
}

export function createBootstrapPatsRouter(eta: Eta, db: Database.Database): Router {
  const router = Router();
  const store = new GlobalSettingsStore(db);

  function renderPanel(res: import('express').Response, flash?: { type: 'success' | 'error'; msg: string }): void {
    const html = eta.render('partials/bootstrap-pats-panel', {
      devopsSet: store.has(DEVOPS_KEY),
      flash,
    });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(html);
  }

  // GET /api/bootstrap-pats — render panel
  router.get('/bootstrap-pats', (_req, res, next) => {
    try {
      renderPanel(res);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/bootstrap-pats/devops — validate + save DevOps bootstrap PAT
  router.post('/bootstrap-pats/devops', async (req, res, next) => {
    try {
      const pat = ((req.body as Record<string, string>)['pat'] ?? '').trim();
      if (!pat) {
        res.status(422).send('<div class="badge badge-error">PAT is required</div>');
        return;
      }

      const result = await validateDevOpsPat(pat);
      if (!result.ok) {
        // Still save it (user may want to fix later), but show the warning
        store.set(DEVOPS_KEY, pat);
        renderPanel(res, { type: 'error', msg: result.reason! });
        return;
      }

      store.set(DEVOPS_KEY, pat);
      renderPanel(res, { type: 'success', msg: 'PAT validated — profile & token management OK.' });
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/bootstrap-pats/devops — clear DevOps bootstrap PAT
  router.delete('/bootstrap-pats/devops', (_req, res, next) => {
    try {
      store.delete(DEVOPS_KEY);
      renderPanel(res);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
