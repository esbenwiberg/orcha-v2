import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

export interface Preset {
  id: string;
  name: string;
  repoId: string;
  credentialProfileId: string;
  createdAt: Date;
}

export interface CreatePresetInput {
  name: string;
  repoId: string;
  credentialProfileId: string;
}

export class PresetStore {
  #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  #rowToPreset(row: Record<string, unknown>): Preset {
    return {
      id: row['id'] as string,
      name: row['name'] as string,
      repoId: (row['repo_id'] as string) ?? '',
      credentialProfileId: (row['credential_profile_id'] as string) ?? '',
      createdAt: new Date(row['created_at'] as string),
    };
  }

  listPresets(): Preset[] {
    const rows = this.#db
      .prepare('SELECT * FROM presets ORDER BY created_at ASC')
      .all() as Record<string, unknown>[];
    return rows.map((row) => this.#rowToPreset(row));
  }

  getPreset(id: string): Preset | undefined {
    const row = this.#db.prepare('SELECT * FROM presets WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return undefined;
    return this.#rowToPreset(row);
  }

  createPreset(input: CreatePresetInput): Preset {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.#db
      .prepare(
        `INSERT INTO presets (id, name, repo_id, credential_profile_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, input.name, input.repoId || null, input.credentialProfileId || null, now);

    return this.getPreset(id)!;
  }

  deletePreset(id: string): void {
    this.#db.prepare('DELETE FROM presets WHERE id = ?').run(id);
  }
}
