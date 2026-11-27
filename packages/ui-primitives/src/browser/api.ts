import type { PluginIcon } from '@mini-harness/plugin-api/descriptor';

export interface FloatingOptions {
  width?: number;
  maxHeight?: number;
  align?: 'start' | 'end';
  prefer?: 'above' | 'below';
}

export interface BrowserPrimitives {
  /** Keep one inline row and move excess actions to a native overflow popover. */
  overflowActions(
    host: HTMLElement,
    label: string,
    signal: AbortSignal,
    space?: HTMLElement,
    available?: () => number,
  ): (nodes: readonly HTMLElement[]) => void;
  icon(spec?: PluginIcon): SVGSVGElement;
  button(label: string, variant?: 'primary' | 'secondary' | 'quiet' | 'danger'): HTMLButtonElement;
  iconButton(label: string, spec: PluginIcon, className?: string): HTMLButtonElement;
  positionFloating(anchor: HTMLElement, panel: HTMLElement, options?: FloatingOptions): void;
  /** Bind a native popover to its trigger and return the function that opens it. */
  bindPopover(
    trigger: HTMLElement,
    panel: HTMLElement,
    signal: AbortSignal,
    options?: FloatingOptions,
  ): () => void;
  field(label: string | HTMLElement, control: HTMLElement, layout?: 'compact' | 'wide'): HTMLElement;
  dialog(title: string, content: HTMLElement): HTMLDialogElement;
  status(text: string, kind?: 'status' | 'alert'): HTMLElement;
  menu(label: string, items: HTMLElement[]): HTMLElement;
  recordRow(title: string | HTMLElement, body: HTMLElement, trailing?: HTMLElement[]): HTMLDetailsElement;
}

declare module 'mini-harness/cordis' {
  interface Context {
    miniPrimitives: BrowserPrimitives;
  }
}
