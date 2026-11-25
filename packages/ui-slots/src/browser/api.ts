/** Plugins declare their own slot names via TypeScript module augmentation. */
export interface SlotMap {}
export type SlotName = keyof SlotMap & string;
export type SlotKind = 'single' | 'list';
export interface SlotMount {
  node: HTMLElement;
  dispose?(): void;
}
export type SlotRenderer = (signal: AbortSignal) => HTMLElement | SlotMount;

export interface KeyedSlotOptions {
  order?: number;
}

declare module 'mini-harness/cordis' {
  interface Context {
    miniSlots: {
      define(name: SlotName, container: HTMLElement, kind?: SlotKind): () => void;
      register(name: SlotName, node: HTMLElement, order?: number): () => void;
      registerKeyed(
        name: SlotName,
        key: string,
        render: SlotRenderer,
        options?: KeyedSlotOptions,
      ): () => void;
    };
  }
}
