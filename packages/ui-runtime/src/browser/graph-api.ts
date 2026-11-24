import type {} from 'mini-harness/cordis';
export type BrowserPluginFailures = ReadonlyMap<string, unknown>;

declare module 'mini-harness/cordis' {
  interface Context {
    miniSwitch: () => Promise<BrowserPluginFailures>;
    miniBrowserFailures: {
      get(id: string): string | undefined;
      subscribe(listener: () => void, signal: AbortSignal): void;
    };
  }
}
