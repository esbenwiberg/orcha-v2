export { WorktreeManager, WorktreeError } from './worktree-manager.js';
export type { WorktreeInfo } from './worktree-manager.js';

export { PtyManager, PtyError } from './pty-manager.js';
export type { SessionTerminal, PtySpawnOptions, TerminalSize } from './session-terminal.js';

export { SessionManager, SessionError } from './session-manager.js';
export type { ActiveSession, CreateSessionOptions } from './session-manager.js';

export { OutputBuffer } from './output-buffer.js';

export { StatusMonitor } from './status-monitor.js';
export type { StatusEvent, SessionStatus } from './status-monitor.js';

export { CLAUDE_PATTERNS } from './claude-patterns.js';
export type { PatternKey } from './claude-patterns.js';

export { CleanupService } from './cleanup-service.js';
export type { CleanupResult } from './cleanup-service.js';

export { ProcessRegistry, _resetForTest } from './process-registry.js';
export type { ShutdownOptions } from './process-registry.js';
