/** Plugins declare their own slot names via TypeScript module augmentation. */
export interface SlotMap {}
export type SlotName = keyof SlotMap & string;
export type SlotKind = 'single' | 'list';
export interface SlotMount {
  node: HTMLElement;
  dispose?(): void;
}
export type SlotRenderer = (signal: AbortSignal) => HTMLElement | SlotMount;

export interface SlotOptions {
  key?: string;
  order?: number;
  /** Higher priority wins for the same key. Equal priorities conflict. */
  priority?: number;
}

declare module 'mini-harness/cordis' {
  interface Context {
    miniSlots: {
      define(name: SlotName, outlet: HTMLElement | ((nodes: readonly HTMLElement[]) => void), kind?: SlotKind): () => void;
      register(name: SlotName, contribution: HTMLElement | SlotRenderer, options?: SlotOptions): () => void;
    };
  }
}
