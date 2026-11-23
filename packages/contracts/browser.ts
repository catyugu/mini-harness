/** Browser plugin graph wire contract; independent of any UI renderer or Host implementation. */
export interface BrowserEntry {
  id: string;
  browser?: string;
  web?: boolean;
  required?: boolean;
  config: Record<string, unknown>;
  requires?: string[];
  inject?: string[];
}

export interface BrowserPrimitives {
  button(label: string, variant?: 'primary' | 'secondary' | 'quiet' | 'danger'): HTMLButtonElement;
  field(label: string, control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): HTMLElement;
  dialog(title: string, content: HTMLElement): HTMLDialogElement;
  status(text: string, kind?: 'status' | 'alert'): HTMLElement;
  menu(label: string, items: HTMLElement[]): HTMLElement;
}
