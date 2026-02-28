import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type { ModelConfig, ModelProvider, CreateModelConfigInput } from '../model-config/types.js';

export class ModelConfigStore {
  #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  #rowToModelConfig(row: Record<string, unknown>): ModelConfig {
    const config = JSON.parse(row['config_json'] as string) as Record<string, unknown>;
    const apiKey = config['apiKey'] as string | undefined;
    const baseUrl = config['baseUrl'] as string | undefined;
    const modelId = config['modelId'] as string | undefined;
    const foundryResource = config['foundryResource'] as string | undefined;
    const extraEnv = config['extraEnv'] as Record<string, string> | undefined;
    return {
      id: row['id'] as string,
      name: row['name'] as string,
      provider: row['provider'] as ModelProvider,
      createdAt: new Date(row['created_at'] as string),
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(modelId !== undefined ? { modelId } : {}),
      ...(foundryResource !== undefined ? { foundryResource } : {}),
      ...(extraEnv !== undefined ? { extraEnv } : {}),
    };
  }

  listConfigs(): ModelConfig[] {
    const rows = this.#db
      .prepare('SELECT * FROM model_configs ORDER BY created_at ASC')
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.#rowToModelConfig(r));
  }

  getConfig(id: string): ModelConfig | undefined {
    const row = this.#db
      .prepare('SELECT * FROM model_configs WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.#rowToModelConfig(row);
  }

  createConfig(input: CreateModelConfigInput): ModelConfig {
    const id = randomUUID();
    const now = new Date().toISOString();

    const configJson: Record<string, unknown> = {};
    if (input.apiKey !== undefined) configJson['apiKey'] = input.apiKey;
    if (input.baseUrl !== undefined) configJson['baseUrl'] = input.baseUrl;
    if (input.modelId !== undefined) configJson['modelId'] = input.modelId;
    if (input.foundryResource !== undefined) configJson['foundryResource'] = input.foundryResource;
    if (input.extraEnv !== undefined) configJson['extraEnv'] = input.extraEnv;

    this.#db
      .prepare(
        `INSERT INTO model_configs (id, name, provider, config_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, input.name, input.provider, JSON.stringify(configJson), now);

    return this.getConfig(id)!;
  }

  deleteConfig(id: string): void {
    this.#db.prepare('DELETE FROM model_configs WHERE id = ?').run(id);
  }
}
