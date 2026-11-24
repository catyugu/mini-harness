import type { PluginMetadata } from '../shared/metadata.js';
import type {} from 'cordis';
import type { ScopeTarget } from '@mini-harness/kernel/scopes';
import type { BrowserEntry } from '@mini-harness/ui-runtime/bootstrap';

declare module 'cordis' {
  interface Context {
    harnessPluginCatalog: {
      metadata(): PluginMetadata[];
      reserved(id: string): boolean;
      diagnostics(): unknown;
      browser(): BrowserEntry[];
      requestScope(id: string, operation: string, target: ScopeTarget, input: unknown, signal: AbortSignal): Promise<unknown>;
      writeBrowserConfig(id: string, patch: unknown, signal: AbortSignal): Promise<void>;
    };
  }
}
