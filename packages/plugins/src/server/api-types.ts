import type { PluginMetadata } from '../shared/metadata.ts';
import type { BrowserEntry } from '@mini-harness/ui-runtime/bootstrap';

declare module 'mini-harness/cordis' {
  interface Context {
    harnessPluginCatalog: {
      metadata(): PluginMetadata[];
      diagnostics(): unknown;
      browser(): BrowserEntry[];
      browserAsset(path: string): { path: string; mime: string } | undefined;
      writeBrowserConfig(id: string, patch: unknown, signal: AbortSignal): Promise<void>;
    };
  }
}
