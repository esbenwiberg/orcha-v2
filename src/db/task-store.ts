import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type {
  Task,
  TaskStatus,
  CreateTaskInput,
  UpdateTaskInput,
  InvestigationResult,
  EnrichmentResult,
  TranscriptEntry,
  TaskEvent,
  InvestigationRating,
} from '../domain/task-types.js';
import { TASK_TRANSITIONS } from '../domain/task-types.js';

export class TaskStore {
  #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  #rowToTask(row: Record<string, unknown>): Task {
    return {
      id: row['id'] as string,
      displayId: row['display_id'] as number,
      repoId: row['repo_id'] as string,
      title: row['title'] as string,
      description: row['description'] as string,
      status: row['status'] as TaskStatus,
      autoEnrich: (row['auto_enrich'] as number) !== 0,
      selfValidate: (row['self_validate'] as number) !== 0,
      mcpServerIds: row['mcp_server_ids'] ? (JSON.parse(row['mcp_server_ids'] as string) as string[]) : [],
      credentialProfileId: (row['credential_profile_id'] as string) ?? '',
      modelConfigId: (row['model_config_id'] as string) ?? '',
      investigationRating: (row['investigation_rating'] as InvestigationRating | null) ?? null,
      investigationResult: row['investigation_result']
        ? (JSON.parse(row['investigation_result'] as string) as InvestigationResult)
        : null,
      investigatedAt: row['investigated_at'] ? new Date(row['investigated_at'] as string) : null,
      enrichedDescription: (row['enriched_description'] as string | null) ?? null,
      enrichmentResult: row['enrichment_result']
        ? (JSON.parse(row['enrichment_result'] as string) as EnrichmentResult)
        : null,
      enrichedAt: row['enriched_at'] ? new Date(row['enriched_at'] as string) : null,
      worktreePath: (row['worktree_path'] as string | null) ?? null,
      sessionId: (row['session_id'] as string | null) ?? null,
      branch: (row['branch'] as string | null) ?? null,
      prUrl: (row['pr_url'] as string | null) ?? null,
      previewUrl: (row['preview_url'] as string | null) ?? null,
      prCommentWatermark: (row['pr_comment_watermark'] as string | null) ?? null,
      reviewFeedback: (row['review_feedback'] as string | null) ?? null,
      createdAt: new Date(row['created_at'] as string),
      updatedAt: new Date(row['updated_at'] as string),
      completedAt: row['completed_at'] ? new Date(row['completed_at'] as string) : null,
      errorMessage: (row['error_message'] as string | null) ?? null,
    };
  }

  createTask(input: CreateTaskInput): Task {
    const id = randomUUID();
    const now = new Date().toISOString();

    const displayId = ((
      this.#db.prepare('SELECT COALESCE(MAX(display_id), 0) + 1 AS next FROM tasks').get() as {
        next: number;
      }
    ).next);

    this.#db
      .prepare(
        `INSERT INTO tasks (id, display_id, repo_id, title, description, status,
           auto_enrich, self_validate, mcp_server_ids, credential_profile_id, model_config_id,
           branch, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        displayId,
        input.repoId,
        input.title,
        input.description,
        input.autoEnrich ? 1 : 0,
        input.selfValidate ? 1 : 0,
        input.mcpServerIds && input.mcpServerIds.length > 0
          ? JSON.stringify(input.mcpServerIds)
          : null,
        input.credentialProfileId || '',
        input.modelConfigId || '',
        input.branch || null,
        now,
        now,
      );

    // Record creation event
    this.#db
      .prepare('INSERT INTO task_events (task_id, to_status, note) VALUES (?, ?, ?)')
      .run(id, 'draft', 'Task created');

    return this.getTask(id)!;
  }

  getTask(id: string): Task | undefined {
    const row = this.#db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return undefined;
    return this.#rowToTask(row);
  }

  getTaskByDisplayId(displayId: number): Task | undefined {
    const row = this.#db.prepare('SELECT * FROM tasks WHERE display_id = ?').get(displayId) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) return undefined;
    return this.#rowToTask(row);
  }

  listTasks(filter?: { status?: TaskStatus; repoId?: string }): Task[] {
    let sql = 'SELECT * FROM tasks';
    const params: unknown[] = [];
    const clauses: string[] = [];

    if (filter?.status !== undefined) {
      clauses.push('status = ?');
      params.push(filter.status);
    }
    if (filter?.repoId !== undefined) {
      clauses.push('repo_id = ?');
      params.push(filter.repoId);
    }

    if (clauses.length > 0) {
      sql += ' WHERE ' + clauses.join(' AND ');
    }
    sql += ' ORDER BY created_at DESC';

    const rows = this.#db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((row) => this.#rowToTask(row));
  }

  updateTask(id: string, patch: UpdateTaskInput): Task | undefined {
    const existing = this.getTask(id);
    if (existing === undefined) return undefined;

    const title = patch.title ?? existing.title;
    const description = patch.description ?? existing.description;
    const autoEnrich = patch.autoEnrich ?? existing.autoEnrich;
    const selfValidate = patch.selfValidate ?? existing.selfValidate;
    const mcpServerIds = patch.mcpServerIds ?? existing.mcpServerIds;
    const credentialProfileId = patch.credentialProfileId ?? existing.credentialProfileId;
    const modelConfigId = patch.modelConfigId ?? existing.modelConfigId;
    const branch = patch.branch ?? existing.branch;
    const errorMessage = patch.errorMessage ?? existing.errorMessage;

    this.#db
      .prepare(
        `UPDATE tasks SET title = ?, description = ?, auto_enrich = ?, self_validate = ?,
           mcp_server_ids = ?, credential_profile_id = ?, model_config_id = ?,
           branch = ?, error_message = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(
        title,
        description,
        autoEnrich ? 1 : 0,
        selfValidate ? 1 : 0,
        mcpServerIds.length > 0 ? JSON.stringify(mcpServerIds) : null,
        credentialProfileId || '',
        modelConfigId || '',
        branch || null,
        errorMessage || null,
        id,
      );

    return this.getTask(id);
  }

  deleteTask(id: string): void {
    this.#db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  }

  /** Get the oldest actionable task (draft, investigating, enriching, or queued). */
  getNextActionable(): Task | undefined {
    const row = this.#db
      .prepare(
        `SELECT * FROM tasks
         WHERE status IN ('draft', 'investigating', 'enriching', 'queued')
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .get() as Record<string, unknown> | undefined;
    if (row === undefined) return undefined;
    return this.#rowToTask(row);
  }

  /** Transition a task to a new status with validation. */
  transition(id: string, to: TaskStatus, note?: string): void {
    const task = this.getTask(id);
    if (task === undefined) throw new Error(`Task '${id}' not found`);

    const allowed = TASK_TRANSITIONS[task.status];
    if (!allowed.includes(to)) {
      throw new Error(`Invalid transition: ${task.status} → ${to}`);
    }

    const updates: string[] = ["status = ?", "updated_at = datetime('now')"];
    const params: unknown[] = [to];

    if (to === 'done' || to === 'failed' || to === 'cancelled') {
      updates.push("completed_at = datetime('now')");
    }

    this.#db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...params, id);

    this.#db
      .prepare('INSERT INTO task_events (task_id, from_status, to_status, note) VALUES (?, ?, ?, ?)')
      .run(id, task.status, to, note || null);
  }

  setInvestigation(id: string, result: InvestigationResult): void {
    this.#db
      .prepare(
        `UPDATE tasks SET
           investigation_rating = ?,
           investigation_result = ?,
           investigated_at = datetime('now'),
           updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(result.rating, JSON.stringify(result), id);
  }

  setEnrichment(id: string, result: EnrichmentResult): void {
    this.#db
      .prepare(
        `UPDATE tasks SET
           enriched_description = ?,
           enrichment_result = ?,
           enriched_at = datetime('now'),
           updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(result.improvedDescription, JSON.stringify(result), id);
  }

  setWorktreePath(id: string, worktreePath: string | null): void {
    this.#db
      .prepare("UPDATE tasks SET worktree_path = ?, updated_at = datetime('now') WHERE id = ?")
      .run(worktreePath, id);
  }

  setExecution(
    id: string,
    data: { sessionId?: string; branch?: string; prUrl?: string; previewUrl?: string },
  ): void {
    const sets: string[] = ["updated_at = datetime('now')"];
    const params: unknown[] = [];

    if (data.sessionId !== undefined) {
      sets.push('session_id = ?');
      params.push(data.sessionId);
    }
    if (data.branch !== undefined) {
      sets.push('branch = ?');
      params.push(data.branch);
    }
    if (data.prUrl !== undefined) {
      sets.push('pr_url = ?');
      params.push(data.prUrl);
    }
    if (data.previewUrl !== undefined) {
      sets.push('preview_url = ?');
      params.push(data.previewUrl);
    }

    this.#db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  }

  setPrCommentWatermark(id: string, watermark: string): void {
    this.#db
      .prepare("UPDATE tasks SET pr_comment_watermark = ?, updated_at = datetime('now') WHERE id = ?")
      .run(watermark, id);
  }

  setReviewFeedback(id: string, feedback: string | null): void {
    this.#db
      .prepare("UPDATE tasks SET review_feedback = ?, updated_at = datetime('now') WHERE id = ?")
      .run(feedback, id);
  }

  // --- Transcript ---

  appendTranscript(
    taskId: string,
    phase: string,
    seq: number,
    eventType: string,
    data: unknown,
  ): void {
    this.#db
      .prepare(
        'INSERT INTO task_transcript (task_id, phase, seq, event_type, data) VALUES (?, ?, ?, ?, ?)',
      )
      .run(taskId, phase, seq, eventType, JSON.stringify(data));
  }

  getTranscript(taskId: string, phase?: string): TranscriptEntry[] {
    let sql = 'SELECT * FROM task_transcript WHERE task_id = ?';
    const params: unknown[] = [taskId];
    if (phase !== undefined) {
      sql += ' AND phase = ?';
      params.push(phase);
    }
    sql += ' ORDER BY phase, seq';

    const rows = this.#db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row['id'] as number,
      taskId: row['task_id'] as string,
      phase: row['phase'] as TranscriptEntry['phase'],
      seq: row['seq'] as number,
      eventType: row['event_type'] as string,
      data: JSON.parse(row['data'] as string) as unknown,
      createdAt: new Date(row['created_at'] as string),
    }));
  }

  getTranscriptCount(taskId: string, phase?: string): number {
    let sql = 'SELECT COUNT(*) AS cnt FROM task_transcript WHERE task_id = ?';
    const params: unknown[] = [taskId];
    if (phase !== undefined) {
      sql += ' AND phase = ?';
      params.push(phase);
    }
    return (this.#db.prepare(sql).get(...params) as { cnt: number }).cnt;
  }

  // --- Events ---

  getEvents(taskId: string): TaskEvent[] {
    const rows = this.#db
      .prepare('SELECT * FROM task_events WHERE task_id = ? ORDER BY occurred_at ASC')
      .all(taskId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row['id'] as number,
      taskId: row['task_id'] as string,
      fromStatus: (row['from_status'] as TaskStatus | null) ?? null,
      toStatus: row['to_status'] as TaskStatus,
      occurredAt: new Date(row['occurred_at'] as string),
      note: (row['note'] as string | null) ?? null,
    }));
  }
}
