import type {} from 'cordis';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type { ModelCatalog } from '../api.js';

declare module 'cordis' {
  interface Context {
    miniModels: {
      get(): ModelCatalog & { recent: ModelChoice };
      subscribe(listener: () => void, signal: AbortSignal): void;
    };
  }
}
