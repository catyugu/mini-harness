import type { EntryTree } from 'mini-harness/cordis';
import type { ResolvedPlugin } from './descriptor.ts';
import type { PluginSettings } from './configuration.ts';

export interface ProfileConfiguration extends PluginSettings {
  port: number;
  readOnlyTools: Record<string, string[]>;
}

export interface ProfileRuntime {
  readonly directory: string;
  readonly descriptors: ResolvedPlugin[];
  readonly modules: ReadonlyMap<string, { name: string; source: string }>;
  start(): Promise<Map<string, unknown>>;
  readonly entries: EntryTree;
  readonly installed: ReadonlyMap<string, string>;
  client(id: string): boolean;
  read(): ProfileConfiguration;
  commit(settings: ProfileConfiguration): void;
  finishMigration(): void;
  close(): Promise<void>;
}

export interface LaunchOptions {
  flags?: readonly string[];
  patches?: readonly string[];
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
