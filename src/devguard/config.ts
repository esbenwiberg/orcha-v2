import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

export interface TaskProfile {
  durationHours: number;
  azure?: {
    subscriptionId: string;
    resourceGroups: string[];
    role: string;
  };
  github?: {
    pat?: string;
  };
  devops?: {
    org: string;
    project: string;
    scopes: string[];
  };
}

export interface RedactionConfig {
  extraPatterns?: Array<{ pattern: string; replacement: string }>;
  disablePatterns?: string[];
}

export interface DevguardConfig {
  name: string;
  taskProfiles: Record<string, TaskProfile>;
  redaction?: RedactionConfig;
}

const CONFIG_FILENAME = '.devguard.yaml';

export function loadConfig(cwd: string): DevguardConfig {
  const configPath = path.join(cwd, CONFIG_FILENAME);
  if (!fs.existsSync(configPath)) {
    throw new Error(`No ${CONFIG_FILENAME} found in ${cwd}. Run \`devguard scaffold\` to create one.`);
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = yaml.load(raw) as Record<string, unknown>;

  const name = (parsed['name'] as string | undefined) ?? path.basename(cwd);
  const taskProfiles = (parsed['task_profiles'] as Record<string, unknown> | undefined) ?? {};

  const profiles: Record<string, TaskProfile> = {};
  for (const [key, value] of Object.entries(taskProfiles)) {
    const v = value as Record<string, unknown>;
    type NonUndefined<T> = T extends undefined ? never : T;
    const azure = v['azure'] as NonUndefined<TaskProfile['azure']> | undefined;
    const github = v['github'] as NonUndefined<TaskProfile['github']> | undefined;
    const devops = v['devops'] as NonUndefined<TaskProfile['devops']> | undefined;
    profiles[key] = {
      durationHours: (v['durationHours'] as number | undefined) ?? 4,
      ...(azure !== undefined ? { azure } : {}),
      ...(github !== undefined ? { github } : {}),
      ...(devops !== undefined ? { devops } : {}),
    };
  }

  return { name, taskProfiles: profiles };
}

export function detectServices(cwd: string): string[] {
  const detected: string[] = [];
  if (
    fs.existsSync(path.join(cwd, 'bicep')) ||
    fs.existsSync(path.join(cwd, 'infra')) ||
    fs.existsSync(path.join(cwd, 'azure-deploy.bicep'))
  ) {
    detected.push('azure');
  }
  if (fs.existsSync(path.join(cwd, '.github'))) {
    detected.push('github');
  }
  if (fs.existsSync(path.join(cwd, 'azure-pipelines.yml'))) {
    detected.push('devops');
  }
  return detected;
}

export function scaffoldConfig(cwd: string, name: string): void {
  const configPath = path.join(cwd, CONFIG_FILENAME);
  const services = detectServices(cwd);

  const azureSection = services.includes('azure')
    ? `    azure:\n      subscriptionId: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"\n      resourceGroups: []\n      role: "Contributor"\n`
    : '';
  const githubSection = services.includes('github')
    ? `    github: {}\n`
    : '';
  const devopsSection = services.includes('devops')
    ? `    devops:\n      org: "https://dev.azure.com/myorg"\n      project: "myproject"\n      scopes: ["vso.code_write", "vso.work_write"]\n`
    : '';

  const content = [
    `name: ${name}`,
    `task_profiles:`,
    `  bugfix:`,
    `    durationHours: 4`,
    azureSection,
    githubSection,
    devopsSection,
    `  readonly:`,
    `    durationHours: 2`,
    services.includes('azure') ? `    azure:\n      role: "Reader"\n` : '',
    services.includes('github') ? `    github: {}\n` : '',
    services.includes('devops') ? `    devops:\n      scopes: ["vso.code"]\n` : '',
  ].join('\n');

  fs.writeFileSync(configPath, content, 'utf8');
}
