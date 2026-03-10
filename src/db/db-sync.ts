/**
 * DB sync hook — allows route handlers to trigger an immediate sync of the
 * in-memory SQLite DB to persistent storage after critical mutations.
 *
 * The actual sync function is registered by start-server.ts at startup.
 * Calling syncDbNow() before registration is a safe no-op.
 */
let _syncFn: (() => void) | undefined;

export function registerSyncFn(fn: () => void): void {
  _syncFn = fn;
}

/** Trigger an immediate DB sync to persistent storage. Safe to call anytime. */
export function syncDbNow(): void {
  _syncFn?.();
}
