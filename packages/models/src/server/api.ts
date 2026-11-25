import type { ModelSummary, ProviderModel } from '../shared/catalog.ts';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';

export interface ModelCatalogPort {
  list(): ModelSummary[];
  available(): Promise<ModelSummary[]>;
  /** Returns undefined when the choice is absent from this catalog. */
  resolve(choice: ModelChoice): ModelChoice | undefined;
  capabilities(choice: ModelChoice): ProviderModel | undefined;
  /** The protocol identifier and endpoint from the configured model. */
  connection(choice: ModelChoice): { api: string; baseUrl: string } | undefined;
  /** Resolve the provider key for server-side adapter code. */
  apiKey(choice: ModelChoice): Promise<string | undefined>;
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
