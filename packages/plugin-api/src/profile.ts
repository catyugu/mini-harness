import type { Context, EntryTree } from 'mini-harness/cordis';
import type { ResolvedPlugin } from './descriptor.ts';
import type { ProfileConfiguration, ScopeAddress } from './configuration.ts';

import type { ScopeKey } from './scopes.ts';

/** A domain's binding from persistent composition to a runtime identity. */
export interface ScopeBinding {
  key: ScopeKey;
  parent?: ScopeAddress;
}

export interface ProfileScopes {
  register(namespace: string, resolve: (id: string) => ScopeBinding | undefined, eager?: boolean): () => void;
  prepare(address: ScopeAddress, signal?: AbortSignal): Promise<void>;
  context(address?: ScopeAddress | null): Context;
  require<Name extends keyof Context & string>(
    address: ScopeAddress | null | undefined,
    service: Name,
  ): NonNullable<Context[Name]>;
  address(address: ScopeAddress): readonly ScopeAddress[];
}

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
    harnessProfileScopes: ProfileScopes;
    harnessLaunch: LaunchOptions;
  }
  interface Events {
    'harness/start'(): void | Promise<void>;
    'harness/open'(): void | Promise<void>;
    'harness/seal'(): void;
    'harness/drain'(): void | Promise<void>;
  }
}
