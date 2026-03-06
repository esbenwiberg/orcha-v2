import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

export interface PresetValidateFields {
  validateMode: string | null;
  validateBuild: string | null;
  validateStart: string | null;
  validateHealth: string | null;
  validateComposeFile: string | null;
  validateTimeout: number | null;
}

export interface Preset extends PresetValidateFields {
  id: string;
  name: string;
  repoId: string;
  credentialProfileId: string;
  modelConfigId: string;
  mcpServerIds: string[];
  createdAt: Date;
}

export interface CreatePresetInput {
  name: string;
  repoId: string;
  credentialProfileId: string;
  modelConfigId: string;
  validateMode?: string;
  validateBuild?: string;
  validateStart?: string;
  validateHealth?: string;
  validateComposeFile?: string;
  validateTimeout?: number;
  mcpServerIds?: string[];
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
      modelConfigId: (row['model_config_id'] as string) ?? '',
      validateMode: (row['validate_mode'] as string | null) ?? null,
      validateBuild: (row['validate_build'] as string | null) ?? null,
      validateStart: (row['validate_start'] as string | null) ?? null,
      validateHealth: (row['validate_health'] as string | null) ?? null,
      validateComposeFile: (row['validate_compose_file'] as string | null) ?? null,
      validateTimeout: (row['validate_timeout'] as number | null) ?? null,
      mcpServerIds: row['mcp_server_ids'] ? (JSON.parse(row['mcp_server_ids'] as string) as string[]) : [],
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
        `INSERT INTO presets (id, name, repo_id, credential_profile_id, model_config_id,
           validate_mode, validate_build, validate_start, validate_health, validate_compose_file, validate_timeout,
           mcp_server_ids, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, input.name, input.repoId || null, input.credentialProfileId || null, input.modelConfigId || null,
        input.validateMode || null, input.validateBuild || null, input.validateStart || null,
        input.validateHealth || null, input.validateComposeFile || null, input.validateTimeout ?? null,
        input.mcpServerIds && input.mcpServerIds.length > 0 ? JSON.stringify(input.mcpServerIds) : null,
        now,
      );

    return this.getPreset(id)!;
  }

  updatePreset(id: string, input: Partial<CreatePresetInput>): Preset | undefined {
    const existing = this.getPreset(id);
    if (existing === undefined) return undefined;

    const name = input.name ?? existing.name;
    const repoId = input.repoId ?? existing.repoId;
    const credentialProfileId = input.credentialProfileId ?? existing.credentialProfileId;
    const modelConfigId = input.modelConfigId ?? existing.modelConfigId;

    const mcpServerIds = input.mcpServerIds ?? existing.mcpServerIds;

    this.#db
      .prepare(
        `UPDATE presets SET name = ?, repo_id = ?, credential_profile_id = ?, model_config_id = ?,
           validate_mode = ?, validate_build = ?, validate_start = ?,
           validate_health = ?, validate_compose_file = ?, validate_timeout = ?,
           mcp_server_ids = ?
         WHERE id = ?`,
      )
      .run(
        name, repoId || null, credentialProfileId || null, modelConfigId || null,
        input.validateMode ?? existing.validateMode,
        input.validateBuild ?? existing.validateBuild,
        input.validateStart ?? existing.validateStart,
        input.validateHealth ?? existing.validateHealth,
        input.validateComposeFile ?? existing.validateComposeFile,
        input.validateTimeout ?? existing.validateTimeout,
        mcpServerIds.length > 0 ? JSON.stringify(mcpServerIds) : null,
        id,
      );

    return this.getPreset(id);
  }

  deletePreset(id: string): void {
    this.#db.prepare('DELETE FROM presets WHERE id = ?').run(id);
  }
}
