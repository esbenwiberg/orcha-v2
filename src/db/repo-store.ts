import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

export type RepoProvider = 'github' | 'azure-devops' | 'other';
export type RepoStatus = 'pending' | 'cloning' | 'ready' | 'error';

export interface Repo {
  id: string;
  url: string;
  provider: RepoProvider;
  displayName: string;
  barePath: string | null;
  status: RepoStatus;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateRepoInput {
  url: string;
  provider?: RepoProvider;
  displayName?: string;
}

/** Detect provider from a repo URL. */
export function detectProvider(url: string): RepoProvider {
  if (/github\.com/i.test(url)) return 'github';
  if (/dev\.azure\.com|visualstudio\.com/i.test(url)) return 'azure-devops';
  return 'other';
}

/** Extract a human-readable display name from a repo URL (e.g. "owner/repo"). */
export function extractDisplayName(url: string): string {
  // Strip protocol and trailing .git
  let cleaned = url
    .replace(/^https?:\/\//, '')
    .replace(/^git@/, '')
    .replace(/\.git$/, '');

  // Azure DevOps: dev.azure.com/{org}/{project}/_git/{repo}
  const adoMatch = /dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)/i.exec(cleaned);
  if (adoMatch !== null) return `${adoMatch[1]}/${adoMatch[2]}/${adoMatch[3]}`;

  // GitHub / generic: host/owner/repo
  const parts = cleaned.split('/');
  if (parts.length >= 3) return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;

  return cleaned;
}

/** Basic repo URL validation. */
export function validateRepoUrl(url: string): string | null {
  if (url.length === 0) return 'Repository URL is required.';
  if (!/^https?:\/\/.+/i.test(url)) return 'URL must start with http:// or https://.';
  return null;
}

export class RepoStore {
  #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  #rowToRepo(row: Record<string, unknown>): Repo {
    return {
      id: row['id'] as string,
      url: row['url'] as string,
      provider: row['provider'] as RepoProvider,
      displayName: row['display_name'] as string,
      barePath: (row['bare_path'] as string | null) ?? null,
      status: row['status'] as RepoStatus,
      error: (row['error'] as string | null) ?? null,
      createdAt: new Date(row['created_at'] as string),
      updatedAt: new Date(row['updated_at'] as string),
    };
  }

  listRepos(): Repo[] {
    const rows = this.#db
      .prepare('SELECT * FROM repos ORDER BY created_at ASC')
      .all() as Record<string, unknown>[];
    return rows.map((row) => this.#rowToRepo(row));
  }

  getRepo(id: string): Repo | undefined {
    const row = this.#db.prepare('SELECT * FROM repos WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return undefined;
    return this.#rowToRepo(row);
  }

  getRepoByUrl(url: string): Repo | undefined {
    const row = this.#db.prepare('SELECT * FROM repos WHERE url = ?').get(url) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return undefined;
    return this.#rowToRepo(row);
  }

  createRepo(input: CreateRepoInput): Repo {
    const id = randomUUID();
    const now = new Date().toISOString();
    const provider = input.provider ?? detectProvider(input.url);
    const displayName = input.displayName ?? extractDisplayName(input.url);

    this.#db
      .prepare(
        `INSERT INTO repos (id, url, provider, display_name, bare_path, status, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, 'pending', NULL, ?, ?)`,
      )
      .run(id, input.url, provider, displayName, now, now);

    return this.getRepo(id)!;
  }

  updateStatus(id: string, status: RepoStatus, extra?: { barePath?: string; error?: string }): Repo {
    const now = new Date().toISOString();

    if (extra?.barePath !== undefined) {
      this.#db
        .prepare('UPDATE repos SET status = ?, bare_path = ?, updated_at = ? WHERE id = ?')
        .run(status, extra.barePath, now, id);
    } else if (extra?.error !== undefined) {
      this.#db
        .prepare('UPDATE repos SET status = ?, error = ?, updated_at = ? WHERE id = ?')
        .run(status, extra.error, now, id);
    } else {
      this.#db
        .prepare('UPDATE repos SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, now, id);
    }

    return this.getRepo(id)!;
  }

  deleteRepo(id: string): void {
    this.#db.prepare('DELETE FROM repos WHERE id = ?').run(id);
  }
}
