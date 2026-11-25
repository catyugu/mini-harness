import type { EntryOptions, EntryTree } from 'mini-harness/cordis';
import type { PluginDescriptor } from './descriptor.js';
import type { PluginSettings } from './configuration.js';

export interface ProfileConfiguration extends PluginSettings {
  port: number;
  readOnlyTools: Record<string, string[]>;
}

export interface ProfileRuntime {
  readonly descriptors: PluginDescriptor[];
  readonly nativeEntries: readonly EntryOptions[];
  readonly entries: EntryTree;
  readonly infrastructure: readonly string[];
  readonly installed: ReadonlyMap<string, string>;
  client(id: string): boolean;
  read(): ProfileConfiguration;
  commit(settings: ProfileConfiguration): void;
  finishMigration(): void;
}

export interface LaunchOptions {
  flags?: readonly string[];
  detached?: boolean;
  token?: string;
  shutdown(): void;
  interactive: boolean;
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessProfile: ProfileRuntime;
    harnessLaunch: LaunchOptions;
  }
  interface Events {
    'harness/start'(): void | Promise<void>;
    'harness/open'(): void | Promise<void>;
    'harness/seal'(): void;
    'harness/drain'(): void | Promise<void>;
  }
}
