/** Browser entry wire contract; independent of any UI renderer or Host implementation. */
export interface BrowserEntry {
  id: string;
  browser: string;
  styles?: string[];
  preload?: string;
  config: Record<string, unknown>;
  live?: boolean;
}

export interface BrowserBootstrap {
  ui: BrowserEntry[];
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessGateway: { bootstrap(): BrowserBootstrap };
  }
}
