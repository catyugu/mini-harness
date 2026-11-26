import type { PluginIcon } from '@mini-harness/plugin-api/descriptor';

export interface FloatingOptions {
  width?: number;
  maxHeight?: number;
  align?: 'start' | 'end';
  prefer?: 'above' | 'below';
}

export interface BrowserPrimitives {
  icon(spec?: PluginIcon): SVGSVGElement;
  button(label: string, variant?: 'primary' | 'secondary' | 'quiet' | 'danger'): HTMLButtonElement;
  iconButton(label: string, spec: PluginIcon, className?: string): HTMLButtonElement;
  positionFloating(anchor: HTMLElement, panel: HTMLElement, options?: FloatingOptions): void;
  bindPopover(
    trigger: HTMLElement,
    panel: HTMLElement,
    signal: AbortSignal,
    options?: FloatingOptions,
  ): () => void;
  field(label: string, control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): HTMLElement;
  dialog(title: string, content: HTMLElement): HTMLDialogElement;
  status(text: string, kind?: 'status' | 'alert'): HTMLElement;
  menu(label: string, items: HTMLElement[]): HTMLElement;
}

declare module 'mini-harness/cordis' {
  interface Context {
    miniPrimitives: BrowserPrimitives;
  }
}
