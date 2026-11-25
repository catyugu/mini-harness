import type { EntryTree } from 'mini-harness/cordis';
import type { ResolvedPlugin } from './descriptor.ts';
import type { ProfileConfiguration } from './configuration.ts';

export interface ProfileRuntime {
  readonly directory: string;
  builtin(id: string, name: string, client: boolean): ResolvedPlugin | undefined;
  source(id: string, name: string): string;
  start(): Promise<Map<string, unknown>>;
  readonly entries: EntryTree;
  read(): ProfileConfiguration;
  commit(settings: ProfileConfiguration): void;
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
