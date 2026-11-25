import type { ThinkingLevel, ModelChoice } from '@mini-harness/llm/vocabulary';

export const providerApiPattern = /^[a-z][a-z0-9-]{0,79}$/;

export interface ModelSummary extends ModelChoice {
  name: string;
  configured: boolean;
  thinkingLevels: ThinkingLevel[];
  input: readonly ('text' | 'image')[];
}

export interface ProviderModel {
  id: string;
  name: string;
  input: readonly ('text' | 'image')[];
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  thinkingLevels?: ThinkingLevel[];
}

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

export interface ModelCatalog {
  models: ModelSummary[];
  providers: ProviderInfo[];
}
