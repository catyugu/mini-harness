import type { PluginConfiguration } from './shared/plugin-configuration.ts';

export interface PluginData {
  read<T>(name: string, fallback: T): T;
  write(name: string, value: unknown): void;
  remove(name: string): void;
}

export interface PluginSecrets {
  read(name: string): string | undefined;
  write(name: string, value: string): void;
  remove(name: string): void;
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessPluginData: PluginData;
    harnessPluginSecrets: PluginSecrets;
    harnessPluginSettings: PluginConfiguration;
    harnessPluginChanges: { invalidate(): void };
  }
}
