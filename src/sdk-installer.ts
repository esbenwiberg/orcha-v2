import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { GlobalSettingsStore } from './db/global-settings-store.js';
import type Database from 'better-sqlite3';

/** SDK definitions — each knows how to check presence and install itself. */
interface SdkDef {
  id: string;
  label: string;
  /** Check if already installed. */
  check: () => boolean;
  /** Install the SDK. Throws on failure. */
  install: () => void;
  /** Directories to prepend to PATH after install (if any). */
  pathDirs?: () => string[];
}

const DOTNET_DIR = '/data/sdks/dotnet';

const SDK_DEFS: SdkDef[] = [
  {
    id: 'typescript',
    label: 'TypeScript (tsc)',
    check: () => {
      try {
        execSync('tsc --version', { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    },
    install: () => {
      execSync('npm install -g typescript', { stdio: 'inherit' });
    },
  },
  {
    id: 'dotnet',
    label: '.NET SDK',
    check: () => {
      try {
        // Check both PATH and our custom install dir
        const dotnetBin = join(DOTNET_DIR, 'dotnet');
        if (existsSync(dotnetBin)) {
          execSync(`${dotnetBin} --version`, { stdio: 'ignore' });
          return true;
        }
        execSync('dotnet --version', { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    },
    install: () => {
      mkdirSync(DOTNET_DIR, { recursive: true });
      // Download and run the official dotnet-install script
      const scriptPath = '/tmp/dotnet-install.sh';
      execSync(
        `curl -fsSL https://dot.net/v1/dotnet-install.sh -o ${scriptPath}`,
        { stdio: 'inherit' },
      );
      chmodSync(scriptPath, 0o755);
      execSync(
        `${scriptPath} --install-dir ${DOTNET_DIR} --channel LTS`,
        { stdio: 'inherit' },
      );
    },
    pathDirs: () => [DOTNET_DIR],
  },
];

/** Returns the list of known SDK definitions (for the settings UI). */
export function getSdkDefs(): Array<{ id: string; label: string }> {
  return SDK_DEFS.map((d) => ({ id: d.id, label: d.label }));
}

/** Read which SDKs are enabled from DB. Returns a Set of SDK ids. */
export function getEnabledSdks(store: GlobalSettingsStore): Set<string> {
  const raw = store.get('sdks_enabled');
  if (!raw) return new Set();
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

/** Save enabled SDK set to DB. */
export function setEnabledSdks(store: GlobalSettingsStore, ids: Set<string>): void {
  const valid = SDK_DEFS.map((d) => d.id);
  const filtered = [...ids].filter((id) => valid.includes(id));
  if (filtered.length === 0) {
    store.delete('sdks_enabled');
  } else {
    store.set('sdks_enabled', filtered.join(','));
  }
}

/**
 * Install enabled SDKs that aren't already present.
 * Called once at server startup. Updates process.env.PATH so sessions inherit it.
 */
export async function installEnabledSdks(db: Database.Database): Promise<void> {
  const store = new GlobalSettingsStore(db);
  const enabled = getEnabledSdks(store);
  if (enabled.size === 0) {
    console.log('[sdks] no SDKs enabled');
    return;
  }

  // First pass: prepend any PATH dirs for already-installed SDKs
  // (e.g. dotnet from a previous boot that persisted to /data/sdks)
  for (const def of SDK_DEFS) {
    if (!enabled.has(def.id)) continue;
    if (def.pathDirs) {
      const dirs = def.pathDirs();
      for (const dir of dirs) {
        if (!process.env['PATH']?.includes(dir)) {
          process.env['PATH'] = `${dir}:${process.env['PATH'] ?? ''}`;
        }
      }
    }
  }

  // Set dotnet env vars so sessions inherit them
  if (enabled.has('dotnet')) {
    process.env['DOTNET_ROOT'] = DOTNET_DIR;
    process.env['DOTNET_CLI_TELEMETRY_OPTOUT'] = '1';
    process.env['DOTNET_NOLOGO'] = '1';
  }

  for (const def of SDK_DEFS) {
    if (!enabled.has(def.id)) continue;

    if (def.check()) {
      console.log(`[sdks] ${def.id} already installed`);
      continue;
    }

    console.log(`[sdks] installing ${def.id}...`);
    try {
      def.install();

      // Add to PATH after install
      if (def.pathDirs) {
        for (const dir of def.pathDirs()) {
          if (!process.env['PATH']?.includes(dir)) {
            process.env['PATH'] = `${dir}:${process.env['PATH'] ?? ''}`;
          }
        }
      }

      console.log(`[sdks] ${def.id} installed`);
    } catch (err) {
      console.error(`[sdks] failed to install ${def.id}:`, err);
    }
  }
}
