import { Router } from 'express';
import type { Eta } from 'eta';
import type { AppDeps } from '../app.js';
import { GlobalSettingsStore } from '../../db/global-settings-store.js';
import { getSdkDefs, getEnabledSdks, setEnabledSdks } from '../../sdk-installer.js';

export function createSdksRouter(eta: Eta, deps: AppDeps): Router {
  const router = Router();
  const store = new GlobalSettingsStore(deps.db);

  router.get('/sdks', (_req, res, next) => {
    try {
      const enabled = getEnabledSdks(store);
      const sdks = getSdkDefs().map((d) => ({ ...d, enabled: enabled.has(d.id) }));
      const html = eta.render('partials/sdks-panel', { sdks, saved: false });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  router.post('/sdks', (req, res, next) => {
    try {
      // Checkboxes: only present in body when checked.
      // Body keys are sdk_<id> = 'on'
      const ids = new Set<string>();
      for (const def of getSdkDefs()) {
        if (req.body[`sdk_${def.id}`] === 'on') {
          ids.add(def.id);
        }
      }
      setEnabledSdks(store, ids);

      const sdks = getSdkDefs().map((d) => ({ ...d, enabled: ids.has(d.id) }));
      const html = eta.render('partials/sdks-panel', { sdks, saved: true });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
