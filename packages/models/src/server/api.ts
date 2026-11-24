import type { ModelSummary, ProviderModel } from '../shared/catalog.js';
import type {} from 'cordis';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';

export interface ModelCatalogPort {
  list(): ModelSummary[];
  available(): Promise<ModelSummary[]>;
  /** Returns undefined when the choice is absent from this catalog. */
  resolve(choice: ModelChoice): ModelChoice | undefined;
  capabilities(choice: ModelChoice): ProviderModel | undefined;
}

declare module 'cordis' {
  interface Context {
    harnessModels: ModelCatalogPort;
    harnessModelPreference: {
      recent(): ModelChoice;
      remember(model: ModelChoice): Promise<void>;
    };
  }
}

declare module '@mini-harness/kernel/services' {
  interface ServiceMap { harnessModels: ModelCatalogPort }
}
