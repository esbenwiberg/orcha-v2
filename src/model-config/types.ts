export type ModelProvider = 'max' | 'anthropic' | 'foundry' | 'local' | 'custom';

export interface ModelConfig {
  id: string;
  name: string;
  provider: ModelProvider;
  apiKey?: string;
  baseUrl?: string;
  modelId?: string;
  foundryResource?: string;
  authToken?: string;
  extraEnv?: Record<string, string>;
  credentialsJson?: string;
  createdAt: Date;
}

export interface CreateModelConfigInput {
  name: string;
  provider: ModelProvider;
  apiKey?: string;
  baseUrl?: string;
  modelId?: string;
  foundryResource?: string;
  authToken?: string;
  extraEnv?: Record<string, string>;
  credentialsJson?: string;
}
