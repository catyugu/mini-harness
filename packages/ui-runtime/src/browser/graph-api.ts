import type {} from 'cordis';
export type BrowserPluginFailures = ReadonlyMap<string, unknown>;

declare module 'cordis' {
  interface Context {
    miniSwitch: () => Promise<BrowserPluginFailures>;
    miniBrowserFailures: {
      has(id: string): boolean;
      subscribe(listener: () => void, signal: AbortSignal): void;
    };
  }
}
