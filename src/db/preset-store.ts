import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

export interface Preset {
  id: string;
  name: string;
  branch: string;
  prompt: string;
  basePath: string;
  createdAt: Date;
}

export interface CreatePresetInput {
  name: string;
  branch: string;
  prompt: string;
  basePath: string;
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
      branch: row['branch'] as string,
      prompt: row['prompt'] as string,
      basePath: row['base_path'] as string,
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
        `INSERT INTO presets (id, name, branch, prompt, base_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.name, input.branch, input.prompt, input.basePath, now);

    return this.getPreset(id)!;
  }

  deletePreset(id: string): void {
    this.#db.prepare('DELETE FROM presets WHERE id = ?').run(id);
  }
}
