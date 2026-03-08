import { Router } from 'express';
import type { Eta } from 'eta';
import type Database from 'better-sqlite3';
import { GlobalSettingsStore } from '../../db/global-settings-store.js';

/** Skill names: lowercase, numbers, hyphens only, max 64 chars. */
const NAME_RE = /^[a-z0-9-]{1,64}$/;

const DB_KEY = 'skills';

export interface StoredSkill {
  name: string;
  content: string;
}

export function loadSkills(store: GlobalSettingsStore): StoredSkill[] {
  const raw = store.get(DB_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as StoredSkill[]) : [];
  } catch {
    return [];
  }
}

function saveSkills(store: GlobalSettingsStore, skills: StoredSkill[]): void {
  if (skills.length === 0) {
    store.delete(DB_KEY);
  } else {
    store.set(DB_KEY, JSON.stringify(skills));
  }
}

export function createSkillsRouter(eta: Eta, db: Database.Database): Router {
  const router = Router();
  const store = new GlobalSettingsStore(db);

  function renderPanel(res: import('express').Response, extra?: Record<string, unknown>): void {
    const skills = loadSkills(store);
    const html = eta.render('partials/skills-panel', { skills, ...extra });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(html);
  }

  // GET /api/skills — render the panel
  router.get('/skills', (_req, res, next) => {
    try {
      renderPanel(res);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/skills — add or update a skill
  router.post('/skills', (req, res, next) => {
    try {
      const name = (typeof req.body['name'] === 'string' ? req.body['name'] : '').trim();
      const content = typeof req.body['content'] === 'string' ? req.body['content'] : '';

      if (!name || !NAME_RE.test(name)) {
        res.status(422).send(
          '<div class="badge badge-error">Invalid name — lowercase, numbers, hyphens only (max 64 chars)</div>',
        );
        return;
      }
      if (!content.trim()) {
        res.status(422).send(
          '<div class="badge badge-error">Skill content cannot be empty</div>',
        );
        return;
      }

      const skills = loadSkills(store);
      const idx = skills.findIndex((s) => s.name === name);
      if (idx >= 0) {
        skills[idx] = { name, content };
      } else {
        skills.push({ name, content });
      }
      saveSkills(store, skills);
      renderPanel(res);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/skills/:name/edit — render the editor for a single skill
  router.get('/skills/:name/edit', (req, res, next) => {
    try {
      const name = req.params['name'] ?? '';
      const skills = loadSkills(store);
      const skill = skills.find((s) => s.name === name);
      const html = eta.render('partials/skill-editor', {
        skill: skill ?? { name, content: '' },
        isNew: !skill,
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(html);
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/skills/:name — remove a skill
  router.delete('/skills/:name', (req, res, next) => {
    try {
      const name = req.params['name'] ?? '';
      const skills = loadSkills(store);
      const filtered = skills.filter((s) => s.name !== name);
      saveSkills(store, filtered);
      renderPanel(res);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
