import type { EntryTree } from 'mini-harness/cordis';
import type { PluginLocation } from './descriptor.ts';
import type { ProfileConfiguration, ScopeAddress } from './configuration.ts';

export interface ProfileRuntime {
  readonly directory: string;
  locate(name: string): PluginLocation | undefined;
  source(id: string, name: string): string;
  start(): Promise<Map<string, unknown>>;
  readonly entries: EntryTree;
  read(): ProfileConfiguration;
  commit(settings: ProfileConfiguration): void;
  close(): Promise<void>;
}

export interface ProfileConfigurationPort {
  readonly settings: ProfileConfiguration;
  /** Whether the initial or updated plugin graph has settled. */
  readonly stable: boolean;
  update(patch: unknown, signal?: AbortSignal): Promise<ProfileConfiguration>;
  forgetScopes(keys: ScopeAddress[]): Promise<void>;
  subscribe(listener: () => void): () => void;
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
    harnessProfileConfig: ProfileConfigurationPort;
    harnessLaunch: LaunchOptions;
  }
  interface Events {
    'harness/ready'(): void | Promise<void>;
    'harness/quiesce'(): void | Promise<void>;
    'harness/start'(): void | Promise<void>;
    'harness/open'(): void | Promise<void>;
    'harness/seal'(): void;
    'harness/drain'(): void | Promise<void>;
  }
}
