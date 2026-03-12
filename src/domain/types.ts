export type SessionStatus =
  | 'pending'
  | 'starting'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface WorktreeInfo {
  worktreePath: string;
  branch: string;
  headSha: string;
  repoRoot: string;
  createdAt: Date;
}

export interface SessionValidateConfig {
  validateMode?: string;
  validateBuild?: string;
  validateStart?: string;
  validateHealth?: string;
  validateHealthPort?: number;
  validateComposeFile?: string;
  validateTimeout?: number;
  validateReadyDelay?: number;
  validateEnv?: Record<string, string>;
}

export interface SessionConfig {
  instanceId: string;
  repoRoot: string;
  branch: string;
  worktreePath: string;
  prompt: string;
  env: Record<string, string>;
  maxRuntimeSeconds: number;
  args?: string[];
  deleteEnv?: string[];
  modelConfigId?: string;
  modelProvider?: string;
  mcpServerIds?: string[];
  privateFeeds?: boolean;
  /** Snapshotted validation config (merged repo + preset fields at session creation time). */
  validateConfig?: SessionValidateConfig;
}

export interface Session {
  id: string;
  displayId: number;
  instanceId: string;
  status: SessionStatus;
  config: SessionConfig;
  worktree: WorktreeInfo;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date | undefined;
  completedAt?: Date | undefined;
  exitCode?: number | undefined;
  errorMessage?: string | undefined;
}

export interface InstanceInfo {
  id: string;
  repoRoot: string;
  registeredAt: Date;
  lastSeenAt: Date;
  activeSessions: number;
}
