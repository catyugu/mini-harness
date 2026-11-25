import type { ModelSummary, ProviderModel } from '../shared/catalog.ts';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';

/** A provider or adapter contributes its models without exposing connection or credential details. */
export interface ModelSource {
  list(): ModelSummary[];
  available?(): Promise<ModelSummary[]>;
  /** Returns undefined when the choice is absent from this catalog. */
  resolve(choice: ModelChoice): ModelChoice | undefined;
  capabilities(choice: ModelChoice): ProviderModel | undefined;
}

export interface ModelCatalogPort extends ModelSource {
  available(): Promise<ModelSummary[]>;
  /** Sources are selected by caller scope, then priority. */
  register(source: ModelSource, priority?: number): () => void;
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
