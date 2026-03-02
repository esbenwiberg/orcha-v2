export interface CredentialProfile {
  id: string;
  name: string;
  durationHours: number;
  azure?: { subscriptionId: string; resourceGroups: string[]; role: string };
  github?: { repos: string[]; permissions: string[]; bootstrapPat: string };
  devops?: { org: string; project: string; scopes: string[]; bootstrapPat: string };
  createdAt: Date;
}

export interface ActiveCredentials {
  id: string;
  sessionId?: string;
  profileId: string;
  profileName: string;
  azureSpName?: string;
  azureAppId?: string;  // Graph object ID used for cleanup
  githubPatId?: string;
  devopsPatId?: string;
  expiresAt: Date;
  revokedAt?: Date;
  createdAt: Date;
}

export interface CreateCredentialProfileInput {
  name: string;
  durationHours: number;
  azure?: { subscriptionId: string; resourceGroups: string[]; role: string };
  github?: { repos: string[]; permissions: string[]; bootstrapPat: string };
  devops?: { org: string; project: string; scopes: string[]; bootstrapPat: string };
}

export interface CreateSessionCredentialsInput {
  sessionId?: string;
  profileId: string;
  profileName: string;
  azureSpName?: string;
  azureAppId?: string;
  githubPatId?: string;
  devopsPatId?: string;
  expiresAt: Date;
}
