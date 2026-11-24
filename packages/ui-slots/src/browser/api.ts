import type {} from 'cordis';
import type { BrowserContributionSource } from '@mini-harness/ui-runtime/contribution';

/** Plugins declare their own slot names via TypeScript module augmentation. */
export interface SlotMap {}
export type SlotName = keyof SlotMap & string;
export type SlotKind = 'single' | 'list';
export interface SlotMount {
  node: HTMLElement;
  dispose?(): void;
}
export type SlotRenderer = (signal: AbortSignal) => HTMLElement | SlotMount;

export interface KeyedSlotOptions { order?: number }

declare module 'cordis' {
  interface Context {
    miniSlots: {
      define(name: SlotName, container: HTMLElement, kind?: SlotKind): () => void;
      register(name: SlotName, node: HTMLElement, order?: number): () => void;
      registerKeyed(name: SlotName, key: string, render: SlotRenderer, options?: KeyedSlotOptions): () => void;
    };
  }
}

export const slotExtensions = {
  define(source: BrowserContributionSource, name: SlotName, container: HTMLElement, kind?: SlotKind) {
    return source.effect(() => source.service('miniSlots').define(name, container, kind));
  },
  register(source: BrowserContributionSource, name: SlotName, node: HTMLElement, order?: number) {
    return source.effect(() => source.service('miniSlots').register(name, node, order));
  },
  keyed(source: BrowserContributionSource, name: SlotName, key: string, render: SlotRenderer, options?: KeyedSlotOptions) {
    return source.effect(() => source.service('miniSlots').registerKeyed(name, key, render, options));
  }
};
