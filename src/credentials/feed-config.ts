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
  /** DevOps project name (optional — omit for org-scoped feeds) */
  project?: string;
  /** Feed names (e.g. ["my-npm-feed", "my-nuget-feed"]) */
  feeds: string[];
  /** The packaging PAT (plain text) */
  pat: string;
}

/**
 * Build the scope segment for feed URLs: "{org}/{project}" or just "{org}".
 */
function feedScope(input: FeedConfigInput): string {
  const orgName = getOrgName(input.org);
  return input.project ? `${orgName}/${input.project}` : orgName;
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
  const scope = feedScope(input);
  const lines: string[] = [];

  for (const feed of input.feeds) {
    const prefix = `pkgs.dev.azure.com/${scope}/_packaging/${feed}`;
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
 *
 * Uses the feed name as-is for the source key (dots are valid in XML element
 * names and commonly used by Azure Artifacts, e.g. "projectum.nuget").
 */
function generateNugetConfig(input: FeedConfigInput): string {
  const orgName = getOrgName(input.org);
  const scope = feedScope(input);

  const sources: string[] = [];
  const creds: string[] = [];

  for (const feed of input.feeds) {
    const url = `https://pkgs.dev.azure.com/${scope}/_packaging/${feed}/nuget/v3/index.json`;
    // Keep dots — they're valid in XML element names and likely match the
    // project's nuget.config source key. Only strip truly illegal chars.
    const key = feed.replace(/[^a-zA-Z0-9._-]/g, '_');
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
 * Build the VSS_NUGET_EXTERNAL_FEED_ENDPOINTS JSON for the Azure Artifacts
 * Credential Provider. This env var is a fallback — it works when the
 * credential provider plugin is installed, regardless of source key names.
 */
function buildVssEndpoints(input: FeedConfigInput): string {
  const scope = feedScope(input);
  const endpoints = input.feeds.map((feed) => ({
    endpoint: `https://pkgs.dev.azure.com/${scope}/_packaging/${feed}/nuget/v3/index.json`,
    password: input.pat,
  }));
  return JSON.stringify({ endpointCredentials: endpoints });
}

export interface FeedConfigResult {
  /** Additional env vars to merge into the session environment. */
  env: Record<string, string>;
}

/**
 * Write .npmrc and NuGet.Config into the per-session HOME directory and
 * return any extra env vars to inject into the session.
 *
 * Call this after the HOME dir is created.
 */
export function writeFeedConfigs(sessionHome: string, input: FeedConfigInput): FeedConfigResult {
  if (input.feeds.length === 0) return { env: {} };

  // ~/.npmrc
  const npmrc = generateNpmrc(input);
  writeFileSync(join(sessionHome, '.npmrc'), npmrc, 'utf8');

  // ~/.nuget/NuGet/NuGet.Config
  const nugetDir = join(sessionHome, '.nuget', 'NuGet');
  mkdirSync(nugetDir, { recursive: true });
  const nugetConfig = generateNugetConfig(input);
  writeFileSync(join(nugetDir, 'NuGet.Config'), nugetConfig, 'utf8');

  // VSS_NUGET_EXTERNAL_FEED_ENDPOINTS — belt-and-suspenders for when
  // the Azure Artifacts Credential Provider is installed. Works regardless
  // of source key naming in the project's nuget.config.
  const env: Record<string, string> = {
    VSS_NUGET_EXTERNAL_FEED_ENDPOINTS: buildVssEndpoints(input),
  };

  return { env };
}
