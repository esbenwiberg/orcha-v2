import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';

export interface PresetValidateFields {
  validateMode: string | null;
  validateBuild: string | null;
  validateStart: string | null;
  validateHealth: string | null;
  validateHealthPort: number | null;
  validateComposeFile: string | null;
  validateTimeout: number | null;
  validateReadyDelay: number | null;
  validateEnv: Record<string, string>;
}

export interface Preset extends PresetValidateFields {
  id: string;
  name: string;
  repoId: string;
  credentialProfileId: string;
  modelConfigId: string;
  webAccess: boolean;
  privateFeeds: boolean;
  mcpServerIds: string[];
  createdAt: Date;
}

export interface CreatePresetInput {
  name: string;
  repoId: string;
  credentialProfileId: string;
  modelConfigId: string;
  webAccess?: boolean;
  privateFeeds?: boolean;
  validateMode?: string;
  validateBuild?: string;
  validateStart?: string;
  validateHealth?: string;
  validateHealthPort?: number;
  validateComposeFile?: string;
  validateTimeout?: number;
  validateReadyDelay?: number;
  validateEnv?: Record<string, string>;
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
      webAccess: (row['web_access'] as number) !== 0,
      privateFeeds: (row['private_feeds'] as number) !== 0,
      validateMode: (row['validate_mode'] as string | null) ?? null,
      validateBuild: (row['validate_build'] as string | null) ?? null,
      validateStart: (row['validate_start'] as string | null) ?? null,
      validateHealth: (row['validate_health'] as string | null) ?? null,
      validateComposeFile: (row['validate_compose_file'] as string | null) ?? null,
      validateTimeout: (row['validate_timeout'] as number | null) ?? null,
      validateHealthPort: (row['validate_health_port'] as number | null) ?? null,
      validateReadyDelay: (row['validate_ready_delay'] as number | null) ?? null,
      validateEnv: (() => {
        const raw = row['validate_env_json'] as string | null;
        if (!raw) return {};
        try { return JSON.parse(raw) as Record<string, string>; } catch { return {}; }
      })(),
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

    const hasValidateEnv = input.validateEnv && Object.keys(input.validateEnv).length > 0;
    this.#db
      .prepare(
        `INSERT INTO presets (id, name, repo_id, credential_profile_id, model_config_id, web_access, private_feeds,
           validate_mode, validate_build, validate_start, validate_health, validate_health_port,
           validate_compose_file, validate_timeout, validate_ready_delay, validate_env_json,
           mcp_server_ids, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, input.name, input.repoId || null, input.credentialProfileId || null, input.modelConfigId || null,
        input.webAccess === false ? 0 : 1,
        input.privateFeeds ? 1 : 0,
        input.validateMode || null, input.validateBuild || null, input.validateStart || null,
        input.validateHealth || null, input.validateHealthPort ?? null,
        input.validateComposeFile || null, input.validateTimeout ?? null,
        input.validateReadyDelay ?? null, hasValidateEnv ? JSON.stringify(input.validateEnv) : null,
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

    const webAccess = input.webAccess ?? existing.webAccess;
    const privateFeeds = input.privateFeeds ?? existing.privateFeeds;
    const mcpServerIds = input.mcpServerIds ?? existing.mcpServerIds;

    const validateEnv = input.validateEnv ?? existing.validateEnv;
    const hasValidateEnv = validateEnv && Object.keys(validateEnv).length > 0;
    this.#db
      .prepare(
        `UPDATE presets SET name = ?, repo_id = ?, credential_profile_id = ?, model_config_id = ?, web_access = ?, private_feeds = ?,
           validate_mode = ?, validate_build = ?, validate_start = ?,
           validate_health = ?, validate_health_port = ?, validate_compose_file = ?,
           validate_timeout = ?, validate_ready_delay = ?, validate_env_json = ?,
           mcp_server_ids = ?
         WHERE id = ?`,
      )
      .run(
        name, repoId || null, credentialProfileId || null, modelConfigId || null,
        webAccess ? 1 : 0,
        privateFeeds ? 1 : 0,
        input.validateMode ?? existing.validateMode,
        input.validateBuild ?? existing.validateBuild,
        input.validateStart ?? existing.validateStart,
        input.validateHealth ?? existing.validateHealth,
        input.validateHealthPort ?? existing.validateHealthPort,
        input.validateComposeFile ?? existing.validateComposeFile,
        input.validateTimeout ?? existing.validateTimeout,
        input.validateReadyDelay ?? existing.validateReadyDelay,
        hasValidateEnv ? JSON.stringify(validateEnv) : null,
        mcpServerIds.length > 0 ? JSON.stringify(mcpServerIds) : null,
        id,
      );

    return this.getPreset(id);
  }

  deletePreset(id: string): void {
    this.#db.prepare('DELETE FROM presets WHERE id = ?').run(id);
  }
}
