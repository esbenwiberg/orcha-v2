import { intro, outro, select, confirm, spinner, note, log, isCancel, cancel } from '@clack/prompts';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, scaffoldConfig } from './config.js';
import * as store from './store.js';
import { AzureProvider } from '../credentials/providers/azure.js';
import { GitHubProvider } from '../credentials/providers/github.js';
import { DevOpsProvider } from '../credentials/providers/devops.js';
import type { TaskProfile } from './config.js';

function formatExpiresAt(isoString: string): string {
  const d = new Date(isoString);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatExpiresIn(isoString: string): string {
  const ms = new Date(isoString).getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

async function cmdInit(cwd: string, dryRun: boolean): Promise<void> {
  intro('devguard — JIT credential manager');

  // Load config
  let config;
  try {
    config = loadConfig(cwd);
  } catch {
    const shouldScaffold = await confirm({
      message: 'No .devguard.yaml found. Scaffold one now?',
    });
    if (isCancel(shouldScaffold) || !shouldScaffold) {
      cancel('Aborted.');
      process.exit(0);
    }
    scaffoldConfig(cwd, path.basename(cwd));
    config = loadConfig(cwd);
    note(`Created ${path.join(cwd, '.devguard.yaml')}`, 'Scaffolded');
  }

  // Pick profile
  const profileNames = Object.keys(config.taskProfiles);
  if (profileNames.length === 0) {
    log.error('No task_profiles defined in .devguard.yaml');
    process.exit(1);
  }

  const profileName = await select<string>({
    message: 'Select task profile',
    options: profileNames.map((name) => ({ value: name, label: name })),
  });

  if (isCancel(profileName)) {
    cancel('Aborted.');
    process.exit(0);
  }

  const profile: TaskProfile = config.taskProfiles[profileName]!;

  // Show what will be provisioned
  const items: string[] = [];
  if (profile.azure) {
    items.push(`Azure SP: ${profile.azure.role} on [${profile.azure.resourceGroups.join(', ')}]`);
  }
  if (profile.github) {
    items.push(`GitHub PAT: ${profile.github.pat ? 'profile PAT' : 'bootstrap PAT (fallback)'}`);
  }
  if (profile.devops) {
    items.push(`DevOps PAT: ${profile.devops.scopes.join(', ')}`);
  }

  note(items.join('\n'), `Will provision (${profile.durationHours}h)`);

  const proceed = await confirm({ message: 'Proceed?' });
  if (isCancel(proceed) || !proceed) {
    cancel('Aborted.');
    process.exit(0);
  }

  if (dryRun) {
    note('Dry run — no credentials provisioned', 'Dry run');
    outro('Done (dry run).');
    return;
  }

  // Provision
  const s = spinner();
  s.start('Provisioning credentials…');

  const env: Record<string, string> = {};
  let azureAppId: string | undefined;
  let githubPatId: string | undefined;
  let devopsPatId: string | undefined;

  try {
    if (profile.azure) {
      const azure = new AzureProvider();
      const result = await azure.provision({ ...profile.azure, durationHours: profile.durationHours });
      azureAppId = result.appId;
      Object.assign(env, result.env);
    }
  } catch (err) {
    s.stop('Azure provisioning failed');
    log.warn(`Azure: ${String(err)}`);
  }

  try {
    if (profile.github) {
      const gh = new GitHubProvider();
      const result = await gh.provision(profile.github);
      if (result.patId) githubPatId = result.patId;
      Object.assign(env, result.env);
    }
  } catch (err) {
    s.stop('GitHub provisioning failed');
    log.warn(`GitHub: ${String(err)}`);
  }

  try {
    if (profile.devops) {
      const devops = new DevOpsProvider();
      const result = await devops.provision({ ...profile.devops, durationHours: profile.durationHours });
      devopsPatId = result.patId;
      Object.assign(env, result.env);
    }
  } catch (err) {
    s.stop('DevOps provisioning failed');
    log.warn(`DevOps: ${String(err)}`);
  }

  s.stop('Credentials provisioned');

  // Write session.env
  const envDir = path.join(cwd, '.devguard');
  if (!fs.existsSync(envDir)) {
    fs.mkdirSync(envDir, { recursive: true });
  }
  const envFile = path.join(envDir, 'session.env');
  const envContent = Object.entries(env)
    .map(([k, v]) => `export ${k}="${v}"`)
    .join('\n');
  fs.writeFileSync(envFile, envContent + '\n', { mode: 0o600 });

  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + profile.durationHours);

  store.saveSession({
    profileName,
    ...(azureAppId !== undefined ? { azureAppId } : {}),
    ...(githubPatId !== undefined ? { githubPatId } : {}),
    ...(devopsPatId !== undefined ? { devopsPatId } : {}),
    expiresAt: expiresAt.toISOString(),
    envFile,
  });

  // Register redaction hook if desired
  await registerRedactionHook(cwd);

  outro(`Session active until ${formatExpiresAt(expiresAt.toISOString())}. Run:\n  source .devguard/session.env && claude`);
}

async function registerRedactionHook(cwd: string): Promise<void> {
  const settingsPath = path.join(cwd, '.claude', 'settings.json');
  const shouldRegister = await confirm({
    message: 'Enable secret redaction hook for Claude sessions?',
    initialValue: true,
  });

  if (isCancel(shouldRegister) || !shouldRegister) return;

  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    } catch {
      settings = {};
    }
  }

  // Find the devguard-redact-hook binary
  const hookPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '../../bin/devguard-redact-hook.js',
  );

  const hookEntry = {
    type: 'command',
    command: `node ${hookPath}`,
  };

  const existingHooks = (settings['hooks'] as Record<string, unknown> | undefined) ?? {};
  const postToolUse = (existingHooks['PostToolUse'] as unknown[] | undefined) ?? [];

  // Add for Bash and Write tools if not already registered
  for (const toolName of ['Bash', 'Write']) {
    const existing = postToolUse.find(
      (h) => (h as Record<string, unknown>)['matcher'] === toolName,
    ) as Record<string, unknown> | undefined;

    if (existing) {
      const hooks = (existing['hooks'] as unknown[] | undefined) ?? [];
      if (!hooks.some((h) => (h as Record<string, unknown>)['command'] === hookEntry.command)) {
        hooks.push(hookEntry);
        existing['hooks'] = hooks;
      }
    } else {
      postToolUse.push({ matcher: toolName, hooks: [hookEntry] });
    }
  }

  settings['hooks'] = { ...existingHooks, PostToolUse: postToolUse };

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  log.success('Redaction hook registered in .claude/settings.json');
}

async function cmdStatus(): Promise<void> {
  const sessions = store.listActiveSessions();
  if (sessions.length === 0) {
    console.log('No active devguard sessions.');
    return;
  }
  console.log('\nActive sessions:\n');
  for (const s of sessions) {
    console.log(`  [${s.id.slice(0, 8)}] ${s.profileName} — expires in ${formatExpiresIn(s.expiresAt)}`);
  }
}

async function cmdRevoke(target: string | '--all' | '--expired'): Promise<void> {
  if (target === '--expired') {
    const expired = store.listExpiredSessions();
    if (expired.length === 0) {
      console.log('No expired sessions to revoke.');
      return;
    }
    for (const s of expired) {
      await revokeSession(s);
    }
    return;
  }

  if (target === '--all') {
    const active = store.listActiveSessions();
    if (active.length === 0) {
      console.log('No active sessions to revoke.');
      return;
    }
    for (const s of active) {
      await revokeSession(s);
    }
    return;
  }

  const s = store.getSession(target);
  if (!s) {
    console.error(`Session ${target} not found.`);
    process.exit(1);
  }
  await revokeSession(s);
}

async function revokeSession(s: store.DevguardSession): Promise<void> {
  try {
    if (s.azureAppId) {
      const azure = new AzureProvider();
      await azure.revoke(s.azureAppId).catch(() => {});
    }
    if (s.githubPatId) {
      const gh = new GitHubProvider();
      await gh.revoke(s.githubPatId).catch(() => {});
    }
    if (s.devopsPatId) {
      const devops = new DevOpsProvider();
      await devops.revoke(s.devopsPatId).catch(() => {});
    }
    store.markRevoked(s.id);
    console.log(`Revoked session ${s.id.slice(0, 8)} (${s.profileName})`);
  } catch (err) {
    console.error(`Failed to revoke ${s.id.slice(0, 8)}: ${String(err)}`);
  }
}

async function cmdScaffold(cwd: string): Promise<void> {
  intro('devguard scaffold');
  const name = path.basename(cwd);
  scaffoldConfig(cwd, name);
  outro(`Created .devguard.yaml in ${cwd}`);
}

async function cmdScrubHistory(projectPath: string): Promise<void> {
  const { scrubHistory } = await import('./scrub-history.js');
  const result = await scrubHistory(projectPath);
  console.log(`Scanned ${result.filesScanned} files, applied ${result.redactionsApplied} redactions.`);
}

// ── Entry point ──────────────────────────────────────────────────────────────

const [,, cmd, ...rawArgs] = process.argv;
const cwd = process.cwd();
const args = rawArgs ?? [];

switch (cmd) {
  case 'init':
    await cmdInit(cwd, args.includes('--dry-run'));
    break;
  case 'status':
    await cmdStatus();
    break;
  case 'revoke': {
    const target = args[0] ?? '--all';
    await cmdRevoke(target as string);
    break;
  }
  case 'scaffold':
    await cmdScaffold(cwd);
    break;
  case 'scrub-history': {
    const p = args[0] ?? cwd;
    await cmdScrubHistory(p);
    break;
  }
  default:
    console.log(`devguard — JIT credential manager

Commands:
  devguard init [--dry-run]     Provision JIT credentials interactively
  devguard status               List active sessions
  devguard revoke [id|--all|--expired]  Revoke credentials
  devguard scaffold             Generate .devguard.yaml
  devguard scrub-history [path] Scrub secrets from Claude history
`);
}
