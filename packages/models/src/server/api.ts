import type { ModelSummary, ProviderModel } from '../shared/catalog.js';
import type {} from 'mini-harness/cordis';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';

export interface ModelCatalogPort {
  list(): ModelSummary[];
  available(): Promise<ModelSummary[]>;
  /** Returns undefined when the choice is absent from this catalog. */
  resolve(choice: ModelChoice): ModelChoice | undefined;
  capabilities(choice: ModelChoice): ProviderModel | undefined;
}

export interface ModelPreference {
  recent(): ModelChoice;
  remember(model: ModelChoice): Promise<void>;
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessModelPreference: ModelPreference;
  }
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessModels: ModelCatalogPort;
  }
}
