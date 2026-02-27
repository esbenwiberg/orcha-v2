import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

export interface DevguardSession {
  id: string;
  profileName: string;
  azureAppId?: string;
  githubPatId?: string;
  devopsPatId?: string;
  expiresAt: string; // ISO 8601
  revokedAt?: string;
  createdAt: string;
  envFile: string; // path to .devguard/session.env
}

function getStoreDir(): string {
  return path.join(os.homedir(), '.devguard');
}

function getStorePath(): string {
  return path.join(getStoreDir(), 'sessions.json');
}

function readSessions(): DevguardSession[] {
  const p = getStorePath();
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as DevguardSession[];
  } catch {
    return [];
  }
}

function writeSessions(sessions: DevguardSession[]): void {
  const dir = getStoreDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(getStorePath(), JSON.stringify(sessions, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
}

export function saveSession(
  session: Omit<DevguardSession, 'id' | 'createdAt'>,
): DevguardSession {
  const sessions = readSessions();
  const newSession: DevguardSession = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    ...session,
  };
  sessions.push(newSession);
  writeSessions(sessions);
  return newSession;
}

export function listSessions(): DevguardSession[] {
  return readSessions();
}

export function listActiveSessions(): DevguardSession[] {
  return readSessions().filter((s) => !s.revokedAt && new Date(s.expiresAt) > new Date());
}

export function listExpiredSessions(): DevguardSession[] {
  return readSessions().filter((s) => !s.revokedAt && new Date(s.expiresAt) <= new Date());
}

export function markRevoked(id: string): void {
  const sessions = readSessions();
  const idx = sessions.findIndex((s) => s.id === id);
  if (idx !== -1) {
    const session = sessions[idx];
    if (session) {
      session.revokedAt = new Date().toISOString();
    }
    writeSessions(sessions);
  }
}

export function getSession(id: string): DevguardSession | undefined {
  return readSessions().find((s) => s.id === id);
}
