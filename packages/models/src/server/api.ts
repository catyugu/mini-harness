import type { ModelSummary, ProviderModel } from '../shared/catalog.ts';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type { LlmAdapter } from '@mini-harness/llm/api';

/** A provider or adapter contributes its models without exposing connection or credential details. */
export interface ModelSource {
  list(): ModelSummary[];
  available?(): Promise<ModelSummary[]>;
  /** Returns undefined when the choice is absent from this catalog. */
  resolve(choice: ModelChoice): ModelChoice | undefined;
  capabilities(choice: ModelChoice): ProviderModel | undefined;
}

export interface ModelSelection {
  model: ModelChoice;
  capabilities: ProviderModel;
}

export interface ModelCatalogPort {
  list(): ModelSummary[];
  available(): Promise<ModelSummary[]>;
  /** A single matched contribution supplies both the model and its capabilities. */
  resolve(choice: ModelChoice): ModelSelection | undefined;
  /** Register model metadata and its adapter together, with one scope, priority and lifetime. */
  register(source: ModelSource, adapter: LlmAdapter, priority?: number): () => void;
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
  interface Events {
    'models/source-changed'(kind: 'catalog' | 'auth'): void | Promise<void>;
    'models/catalog-changed'(): void | Promise<void>;
  }
}
