import type {} from 'mini-harness/cordis';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type { ModelCatalog } from '../shared/catalog.js';

declare module 'mini-harness/cordis' {
  interface Context {
    miniModels: {
      get(): ModelCatalog & { recent: ModelChoice };
      subscribe(listener: () => void, signal: AbortSignal): void;
    };
  }
}
