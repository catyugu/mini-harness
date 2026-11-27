import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type { ModelCatalog, ModelSummary } from '../shared/catalog.ts';

export interface ModelPickerOptions {
  emptyLabel?: string;
  label?: string;
  variant?: 'quiet' | 'secondary';
  selectEmpty?(): void;
}

export interface ModelPicker {
  node: HTMLElement;
  open(): void;
  selected(): ModelSummary | undefined;
  update(choice: ModelChoice | null): ModelSummary | undefined;
}

declare module 'mini-harness/cordis' {
  interface Context {
    miniModels: {
      get(): ModelCatalog & { recent: ModelChoice };
      createPicker(
        onSelect: (choice: ModelChoice) => void,
        signal: AbortSignal,
        options?: ModelPickerOptions,
      ): ModelPicker;
      subscribe(listener: () => void, signal: AbortSignal): void;
    };
  }
}
