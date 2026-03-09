import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Extract the short org name from a DevOps org URL or plain name.
 * e.g. "https://dev.azure.com/myorg" → "myorg", "myorg" → "myorg"
 */
function getOrgName(org: string): string {
  const match = /dev\.azure\.com\/([^/]+)/.exec(org);
  return match ? (match[1] ?? org) : org;
}

export interface FeedConfigInput {
  /** DevOps org URL or name */
  org: string;
  /** DevOps project name */
  project: string;
  /** Feed names (e.g. ["my-npm-feed", "my-nuget-feed"]) */
  feeds: string[];
  /** The session-scoped PAT (plain text) */
  pat: string;
}

/**
 * Generate a user-level .npmrc with auth tokens for Azure DevOps feeds.
 *
 * Projects define their own registry URLs in their local .npmrc;
 * this user-level file only provides the auth tokens so npm/yarn can authenticate.
 */
function generateNpmrc(input: FeedConfigInput): string {
  const orgName = getOrgName(input.org);
  const base64Pat = Buffer.from(input.pat).toString('base64');
  const lines: string[] = [];

  for (const feed of input.feeds) {
    const prefix = `pkgs.dev.azure.com/${orgName}/${input.project}/_packaging/${feed}`;
    lines.push(
      `; ${feed}`,
      `//${prefix}/npm/registry/:username=${orgName}`,
      `//${prefix}/npm/registry/:_password=${base64Pat}`,
      `//${prefix}/npm/registry/:email=noreply@orcha.dev`,
      `//${prefix}/npm/:username=${orgName}`,
      `//${prefix}/npm/:_password=${base64Pat}`,
      `//${prefix}/npm/:email=noreply@orcha.dev`,
      '',
    );
  }

  return lines.join('\n');
}

/**
 * Generate a user-level NuGet.Config with package sources + credentials
 * for Azure DevOps feeds.
 */
function generateNugetConfig(input: FeedConfigInput): string {
  const orgName = getOrgName(input.org);

  const sources: string[] = [];
  const creds: string[] = [];

  for (const feed of input.feeds) {
    const url = `https://pkgs.dev.azure.com/${orgName}/${input.project}/_packaging/${feed}/nuget/v3/index.json`;
    // XML-safe key: replace spaces/special chars
    const key = feed.replace(/[^a-zA-Z0-9_-]/g, '_');
    sources.push(`    <add key="${key}" value="${url}" />`);
    creds.push(
      `    <${key}>`,
      `      <add key="Username" value="${orgName}" />`,
      `      <add key="ClearTextPassword" value="${input.pat}" />`,
      `    </${key}>`,
    );
  }

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<configuration>',
    '  <packageSources>',
    ...sources,
    '  </packageSources>',
    '  <packageSourceCredentials>',
    ...creds,
    '  </packageSourceCredentials>',
    '</configuration>',
    '',
  ].join('\n');
}

/**
 * Write .npmrc and NuGet.Config into the per-session HOME directory.
 * Call this after the HOME dir is created and the DevOps PAT is available.
 */
export function writeFeedConfigs(sessionHome: string, input: FeedConfigInput): void {
  if (input.feeds.length === 0) return;

  // ~/.npmrc
  const npmrc = generateNpmrc(input);
  writeFileSync(join(sessionHome, '.npmrc'), npmrc, 'utf8');

  // ~/.nuget/NuGet/NuGet.Config
  const nugetDir = join(sessionHome, '.nuget', 'NuGet');
  mkdirSync(nugetDir, { recursive: true });
  const nugetConfig = generateNugetConfig(input);
  writeFileSync(join(nugetDir, 'NuGet.Config'), nugetConfig, 'utf8');
}
