import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type {
  CredentialProfile,
  ActiveCredentials,
  CreateCredentialProfileInput,
  CreateSessionCredentialsInput,
} from '../credentials/types.js';
import { encrypt, decrypt } from '../credentials/crypto.js';

export class CredentialStore {
  #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  // ── Credential Profiles ──────────────────────────────────────────────────

  #decryptGithub(raw: string): CredentialProfile['github'] {
    const parsed = JSON.parse(raw) as { repos: string[]; permissions: string[]; bootstrapPat: string };
    return { ...parsed, bootstrapPat: decrypt(parsed.bootstrapPat) };
  }

  #encryptGithub(github: { repos: string[]; permissions: string[]; bootstrapPat: string }): string {
    return JSON.stringify({ ...github, bootstrapPat: encrypt(github.bootstrapPat) });
  }

  #decryptDevops(raw: string): CredentialProfile['devops'] {
    const parsed = JSON.parse(raw) as { org: string; project: string; scopes: string[]; bootstrapPat: string };
    return { ...parsed, bootstrapPat: decrypt(parsed.bootstrapPat) };
  }

  #encryptDevops(devops: { org: string; project: string; scopes: string[]; bootstrapPat: string }): string {
    return JSON.stringify({ ...devops, bootstrapPat: encrypt(devops.bootstrapPat) });
  }

  #rowToProfile(row: Record<string, unknown>): CredentialProfile {
    const github = row['github_json'] ? this.#decryptGithub(row['github_json'] as string) : undefined;
    const devops = row['devops_json'] ? this.#decryptDevops(row['devops_json'] as string) : undefined;
    return {
      id: row['id'] as string,
      name: row['name'] as string,
      durationHours: row['duration_hours'] as number,
      azure: row['azure_json'] ? JSON.parse(row['azure_json'] as string) : undefined,
      ...(github !== undefined ? { github } : {}),
      ...(devops !== undefined ? { devops } : {}),
      createdAt: new Date(row['created_at'] as string),
    };
  }

  listProfiles(): CredentialProfile[] {
    const rows = this.#db
      .prepare('SELECT * FROM credential_profiles ORDER BY created_at ASC')
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.#rowToProfile(r));
  }

  getProfile(id: string): CredentialProfile | undefined {
    const row = this.#db
      .prepare('SELECT * FROM credential_profiles WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.#rowToProfile(row);
  }

  createProfile(input: CreateCredentialProfileInput): CredentialProfile {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.#db
      .prepare(
        `INSERT INTO credential_profiles (id, name, duration_hours, azure_json, github_json, devops_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.durationHours,
        input.azure ? JSON.stringify(input.azure) : null,
        input.github ? this.#encryptGithub(input.github) : null,
        input.devops ? this.#encryptDevops(input.devops) : null,
        now,
      );

    return this.getProfile(id)!;
  }

  updateProfile(id: string, input: Partial<CreateCredentialProfileInput>): CredentialProfile | undefined {
    const existing = this.getProfile(id);
    if (existing === undefined) return undefined;

    const name = input.name ?? existing.name;
    const durationHours = input.durationHours ?? existing.durationHours;
    const azure = input.azure !== undefined ? input.azure : existing.azure;
    const github = input.github !== undefined ? input.github : existing.github;
    const devops = input.devops !== undefined ? input.devops : existing.devops;

    this.#db
      .prepare(
        `UPDATE credential_profiles SET name = ?, duration_hours = ?, azure_json = ?, github_json = ?, devops_json = ? WHERE id = ?`,
      )
      .run(
        name,
        durationHours,
        azure ? JSON.stringify(azure) : null,
        github ? this.#encryptGithub(github) : null,
        devops ? this.#encryptDevops(devops) : null,
        id,
      );

    return this.getProfile(id);
  }

  deleteProfile(id: string): void {
    this.#db.prepare('DELETE FROM credential_profiles WHERE id = ?').run(id);
  }

  // ── Session Credentials ──────────────────────────────────────────────────

  #rowToActiveCreds(row: Record<string, unknown>): ActiveCredentials {
    const sessionId = row['session_id'] as string | null;
    const azureSpName = row['azure_sp_name'] as string | null;
    const azureAppId = row['azure_app_id'] as string | null;
    const githubPatId = row['github_pat_id'] as string | null;
    const devopsPatId = row['devops_pat_id'] as string | null;
    const revokedAt = row['revoked_at'] as string | null;
    return {
      id: row['id'] as string,
      profileId: row['profile_id'] as string,
      profileName: row['profile_name'] as string,
      expiresAt: new Date(row['expires_at'] as string),
      createdAt: new Date(row['created_at'] as string),
      ...(sessionId !== null ? { sessionId } : {}),
      ...(azureSpName !== null ? { azureSpName } : {}),
      ...(azureAppId !== null ? { azureAppId } : {}),
      ...(githubPatId !== null ? { githubPatId } : {}),
      ...(devopsPatId !== null ? { devopsPatId } : {}),
      ...(revokedAt !== null ? { revokedAt: new Date(revokedAt) } : {}),
    };
  }

  createSessionCredentials(input: CreateSessionCredentialsInput): ActiveCredentials {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.#db
      .prepare(
        `INSERT INTO session_credentials
           (id, session_id, profile_id, profile_name, azure_sp_name, azure_app_id, github_pat_id, devops_pat_id, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId ?? null,
        input.profileId,
        input.profileName,
        input.azureSpName ?? null,
        input.azureAppId ?? null,
        input.githubPatId ?? null,
        input.devopsPatId ?? null,
        input.expiresAt.toISOString(),
        now,
      );

    return this.#rowToActiveCreds(
      this.#db
        .prepare('SELECT * FROM session_credentials WHERE id = ?')
        .get(id) as Record<string, unknown>,
    );
  }

  getBySessionId(sessionId: string): ActiveCredentials | undefined {
    const row = this.#db
      .prepare('SELECT * FROM session_credentials WHERE session_id = ? AND revoked_at IS NULL')
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.#rowToActiveCreds(row);
  }

  getById(id: string): ActiveCredentials | undefined {
    const row = this.#db
      .prepare('SELECT * FROM session_credentials WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.#rowToActiveCreds(row);
  }

  markRevoked(id: string): void {
    this.#db
      .prepare('UPDATE session_credentials SET revoked_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
  }

  listExpired(): ActiveCredentials[] {
    const now = new Date().toISOString();
    const rows = this.#db
      .prepare(
        'SELECT * FROM session_credentials WHERE expires_at < ? AND revoked_at IS NULL',
      )
      .all(now) as Record<string, unknown>[];
    return rows.map((r) => this.#rowToActiveCreds(r));
  }

  listAll(): ActiveCredentials[] {
    const rows = this.#db
      .prepare('SELECT * FROM session_credentials ORDER BY created_at DESC')
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.#rowToActiveCreds(r));
  }

  listExpiringWithin(minutes: number): ActiveCredentials[] {
    const now = new Date();
    const threshold = new Date(now.getTime() + minutes * 60 * 1000).toISOString();
    const rows = this.#db
      .prepare(
        `SELECT * FROM session_credentials
         WHERE expires_at <= ? AND expires_at > ? AND revoked_at IS NULL`,
      )
      .all(threshold, now.toISOString()) as Record<string, unknown>[];
    return rows.map((r) => this.#rowToActiveCreds(r));
  }
}
