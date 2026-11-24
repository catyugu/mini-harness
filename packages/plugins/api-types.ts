import type {} from 'cordis';
import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import type { BrowserEntry } from '@mini-harness/ui-runtime/bootstrap';

export interface PluginMetadata extends Pick<PluginDescriptor, 'id' | 'scope' | 'title' | 'description'
  | 'provides' | 'defaultEnabled' | 'web' | 'browser' | 'icon' | 'configGroups' | 'configHint' | 'requires' | 'configSchema'> {
  trustedCode?: boolean;
  package?: { name: string; version: string };
  error?: string;
  state?: 'disabled' | 'inactive' | 'ready' | 'partial' | 'failed';
  instances?: { scope: string; state: 'ready' | 'failed' | 'inactive' | 'disabled'; error?: string }[];
}

declare module 'cordis' {
  interface Context {
    harnessPluginCatalog: {
      metadata(): PluginMetadata[];
      reserved(id: string): boolean;
      diagnostics(): unknown;
      browser(): BrowserEntry[];
      writeBrowserConfig(id: string, patch: unknown, signal: AbortSignal): Promise<void>;
    };
  }
}
