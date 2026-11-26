import type { InputMeasurement } from '@mini-harness/llm/api';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';

export interface ContextSettings {
  autoCompact: boolean;
  triggerRatio: number;
  targetRatio: number;
  retainRatio: number;
  summaryModel: ModelChoice | null;
}

export interface ContextOccupancy extends InputMeasurement {
  model: ModelChoice;
  total: number;
}

export interface TokenTotals {
  input: number;
  cacheRead: number;
  cacheWrite?: number;
  output: number;
}

export interface ContextState {
  settings: ContextSettings;
  customized: boolean;
  occupancy?: ContextOccupancy;
  compacting?: 'manual';
  turns: number;
  steps: number;
  modelMs?: number;
  toolMs?: number;
  ttftMs?: number;
  tokensPerSecond?: number;
  usage?: TokenTotals;
  assistantUsage: Record<string, TokenTotals>;
}
