import type { Context } from 'mini-harness/cordis';
import type { EntryConfiguration } from './configuration.ts';

export interface ScopeSettings {
  entries?: Record<string, EntryConfiguration>;
  /** Services isolated from the parent even if a local provider fails or is disabled. */
  isolate?: string[];
  disabledTools?: string[];
}

/** Stable namespaced key. Namespace and identity are defined by scope providers. */
export type ScopeKey = `${string}:${string}`;

export interface ScopeAddress {
  parent?: ScopeKey;
}

export interface ScopeOption {
  key: ScopeKey;
  name: string;
}

export interface ScopePort {
  register(
    namespace: string,
    resolve: (id: string) => ScopeAddress | undefined,
    eager?: boolean,
  ): () => void;
  prepare(key: ScopeKey, signal?: AbortSignal): Promise<void>;
  /** Read the nearest prepared Cordis service without changing a parent or sibling scope. */
  require<Name extends keyof Context & string>(
    key: ScopeKey | null | undefined,
    service: Name,
  ): NonNullable<Context[Name]>;
  context(key?: ScopeKey | null): Context;
  address(key: ScopeKey): readonly ScopeKey[];
}

declare module 'mini-harness/cordis' {
  interface Events {
    'scopes/list'(options: ScopeOption[]): void;
  }
  interface Context {
    harnessScopes: ScopePort;
  }
}
