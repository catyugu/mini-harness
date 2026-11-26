import type { InputTokenCounts } from '@mini-harness/llm/api';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';

export interface ContextSettings {
  autoCompact: boolean;
  triggerRatio: number;
  targetRatio: number;
  retainRatio: number;
  summaryModel: ModelChoice | null;
}

export interface ContextOccupancy extends InputTokenCounts {
  model: ModelChoice;
  total: number;
  window?: number;
  budget?: number;
  estimated: boolean;
}

export interface TokenTotals {
  input: number;
  cacheRead: number;
  cacheWrite?: number;
  output: number;
}

export interface ContextState {
  settings: ContextSettings;
  custom: ContextSettings | null;
  occupancy?: ContextOccupancy;
  compacting?: 'automatic' | 'manual' | 'recovery';
  turns: number;
  steps: number;
  modelMs?: number;
  toolMs?: number;
  ttftMs?: number;
  tokensPerSecond?: number;
  usage?: TokenTotals;
  assistantUsage: Record<string, TokenTotals>;
}
