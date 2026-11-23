export interface ProviderInfo {
  id: string;
  name: string;
  configured: boolean;
  storedCredential: boolean;
  canSetKey: boolean;
  custom: boolean;
  baseUrl: string;
  api: string;
  models: ProviderModel[];
}

export interface ProviderModel {
  id: string;
  name: string;
  input: string[];
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
}

