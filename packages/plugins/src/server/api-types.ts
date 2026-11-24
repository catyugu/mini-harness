import type { PluginMetadata } from '../shared/metadata.js';
import type {} from 'mini-harness/cordis';
import type { BrowserEntry } from '@mini-harness/ui-runtime/bootstrap';

declare module 'mini-harness/cordis' {
  interface Context {
    harnessPluginCatalog: {
      metadata(): PluginMetadata[];
      reserved(id: string): boolean;
      diagnostics(): unknown;
      browser(): BrowserEntry[];
      requestScope(plugin: string, key: string, operation: string, input: unknown, signal: AbortSignal): Promise<unknown>;
      writeBrowserConfig(id: string, patch: unknown, signal: AbortSignal): Promise<void>;
    };
  }
}
