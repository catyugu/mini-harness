/** Browser plugin graph wire contract; independent of any UI renderer or Host implementation. */
export interface BrowserEntry {
  id: string;
  browser?: string;
  styles?: string[];
  preload?: string;
  required?: boolean;
  config: Record<string, unknown>;
  liveConfig?: boolean;
  requires?: string[];
  inject?: string[];
}

export interface BrowserBootstrap { ui: BrowserEntry[] }

export interface BrowserPrimitives {
  button(label: string, variant?: 'primary' | 'secondary' | 'quiet' | 'danger'): HTMLButtonElement;
  field(label: string, control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): HTMLElement;
  dialog(title: string, content: HTMLElement): HTMLDialogElement;
  status(text: string, kind?: 'status' | 'alert'): HTMLElement;
  menu(label: string, items: HTMLElement[]): HTMLElement;
}

/** Feature-owned live projections subscribe without coupling the browser boot to their data. */
export interface BrowserProjection {
  sync(revision: number, reconnect: boolean, id?: string): Promise<void> | void;
}

export interface BrowserProjectionPort {
  register(domain: string, projection: BrowserProjection): () => void;
}
