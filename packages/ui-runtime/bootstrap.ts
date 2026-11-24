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
