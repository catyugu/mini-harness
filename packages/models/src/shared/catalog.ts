import type { ThinkingLevel, ModelChoice } from '@mini-harness/llm/vocabulary';

export const providerIdPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const providerApiPattern = /^[a-z][a-z0-9-]{0,79}$/;

export const modelProtocols = {
  'openai-completions': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
  'google-generative-ai': 'Google Generative AI',
} as const;

export const modelDefaults = { contextWindow: 128000, maxTokens: 8192 } as const;
export const maxModelTokens = 10000000;

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
  defaultBaseUrl: string;
  endpointCustomized: boolean;
  modelsCustomized: boolean;
}

export interface ModelCatalog {
  models: ModelSummary[];
  providers: ProviderInfo[];
}
