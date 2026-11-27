import type { ThinkingLevel, ModelChoice } from '@mini-harness/llm/vocabulary';

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

export interface ModelCatalog {
  models: ModelSummary[];
  providers: { id: string; name: string }[];
}
