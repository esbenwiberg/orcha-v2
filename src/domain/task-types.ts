export type TaskStatus =
  | 'draft'
  | 'investigating'
  | 'rejected'
  | 'enriching'
  | 'queued'
  | 'executing'
  | 'done'
  | 'failed'
  | 'cancelled';

export type InvestigationRating = 'reject' | 'weak' | 'viable' | 'good' | 'excellent';

export interface InvestigationResult {
  rating: InvestigationRating;
  summary: string;
  reasoning: string;
  pros: string[];
  cons: string[];
  filesExamined: string[];
  webResearch?: string;
}

export interface EnrichmentResult {
  improvedDescription: string;
  affectedFiles: Array<{
    path: string;
    reason: string;
    changeType: 'modify' | 'create' | 'delete';
  }>;
  approach: Array<{
    step: number;
    description: string;
    files: string[];
  }>;
  risks: Array<{
    description: string;
    severity: 'low' | 'medium' | 'high';
    mitigation: string;
  }>;
  complexity: 'trivial' | 'small' | 'medium' | 'large';
  acceptanceCriteria: string[];
  relatedCode: Array<{
    path: string;
    lines: string;
    relevance: string;
  }>;
}

export interface Task {
  id: string;
  displayId: number;
  repoId: string;
  title: string;
  description: string;
  status: TaskStatus;

  // Toggles
  autoEnrich: boolean;
  selfValidate: boolean;
  mcpServerIds: string[];
  credentialProfileId: string;
  modelConfigId: string;

  // Investigation
  investigationRating: InvestigationRating | null;
  investigationResult: InvestigationResult | null;
  investigatedAt: Date | null;

  // Enrichment
  enrichedDescription: string | null;
  enrichmentResult: EnrichmentResult | null;
  enrichedAt: Date | null;

  // Execution
  sessionId: string | null;
  branch: string | null;
  prUrl: string | null;
  previewUrl: string | null;

  // Lifecycle
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  errorMessage: string | null;
}

export interface CreateTaskInput {
  repoId: string;
  title: string;
  description: string;
  autoEnrich?: boolean;
  selfValidate?: boolean;
  mcpServerIds?: string[];
  credentialProfileId?: string;
  modelConfigId?: string;
  branch?: string;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  autoEnrich?: boolean;
  selfValidate?: boolean;
  mcpServerIds?: string[];
  credentialProfileId?: string;
  modelConfigId?: string;
  branch?: string;
  errorMessage?: string;
}

export interface TranscriptEntry {
  id: number;
  taskId: string;
  phase: 'investigate' | 'enrich' | 'execute';
  seq: number;
  eventType: string;
  data: unknown;
  createdAt: Date;
}

export interface TaskEvent {
  id: number;
  taskId: string;
  fromStatus: TaskStatus | null;
  toStatus: TaskStatus;
  occurredAt: Date;
  note: string | null;
}

/** Valid task status transitions. */
export const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  draft: ['investigating', 'queued', 'cancelled'],
  investigating: ['rejected', 'enriching', 'failed', 'cancelled'],
  rejected: ['enriching', 'queued', 'cancelled'],
  enriching: ['queued', 'failed', 'cancelled'],
  queued: ['executing', 'cancelled'],
  executing: ['done', 'failed', 'cancelled'],
  done: [],
  failed: ['draft', 'queued', 'cancelled'],
  cancelled: ['draft'],
};
