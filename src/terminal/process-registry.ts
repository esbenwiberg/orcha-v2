import { SessionManager } from './session-manager.js';
import { CleanupService } from './cleanup-service.js';

export interface ShutdownOptions {
  timeoutMs?: number;
  runCleanupFirst?: boolean;
}

let _instance: ProcessRegistry | undefined = undefined;

export function _resetForTest(): void {
  if (process.env['NODE_ENV'] !== 'test') return;
  _instance = undefined;
}

export class ProcessRegistry {
  private _managers: Set<SessionManager> = new Set();
  private _shutdownRegistered: boolean = false;

  private constructor() {}

  static getInstance(): ProcessRegistry {
    if (_instance === undefined) {
      _instance = new ProcessRegistry();
    }
    return _instance;
  }

  register(manager: SessionManager): void {
    this._managers.add(manager);
  }

  unregister(manager: SessionManager): void {
    this._managers.delete(manager);
  }

  registerShutdownHandlers(cleanup?: CleanupService, opts: ShutdownOptions = {}): void {
    if (this._shutdownRegistered) return;
    this._shutdownRegistered = true;
    process.once('SIGTERM', () => this._shutdown(cleanup, opts));
    process.once('SIGINT', () => this._shutdown(cleanup, opts));
  }

  private async _shutdown(cleanup: CleanupService | undefined, opts: ShutdownOptions): Promise<void> {
    cleanup?.stop();
    if (opts.runCleanupFirst) {
      try {
        await cleanup?.runOnce();
      } catch (e) {
        process.stderr.write(String(e) + '\n');
      }
    }
    await Promise.allSettled(Array.from(this._managers).map((m) => m.stopAllSessions()));
    const timer = setTimeout(() => process.exit(1), opts.timeoutMs ?? 8000);
    timer.unref();
    process.exit(0);
  }
}
