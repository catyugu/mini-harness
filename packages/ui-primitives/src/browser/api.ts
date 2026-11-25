import type { PluginIcon } from '@mini-harness/plugin-api/descriptor';

export interface BrowserPrimitives {
  icon(spec?: PluginIcon): SVGSVGElement;
  button(label: string, variant?: 'primary' | 'secondary' | 'quiet' | 'danger'): HTMLButtonElement;
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
