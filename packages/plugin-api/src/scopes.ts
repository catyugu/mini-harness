import type { Context } from 'mini-harness/cordis';
import type { EntryConfiguration } from './configuration.ts';

export type PluginScope =
  | { kind: 'application' }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'session'; workspaceId: string; sessionId: string };

export interface ScopeSettings {
  entries?: Record<string, EntryConfiguration>;
  /** Services isolated from the parent even if a local provider fails or is disabled. */
  isolate?: string[];
  disabledTools?: string[];
}

export type HostServices = Context;

export type ScopeKey = `${Exclude<PluginScope['kind'], 'application'>}:${string}`;

export type ScopeAddress = { scope: Exclude<PluginScope, { kind: 'application' }>; parent?: ScopeKey };

export interface ScopePort {
  register(
    kind: ScopeAddress['scope']['kind'],
    resolve: (id: string) => ScopeAddress | undefined,
    eager?: boolean,
  ): () => void;
  prepare(key: ScopeKey, signal?: AbortSignal): Promise<void>;
  /** Read the nearest prepared Cordis service without changing a parent or sibling scope. */
  require<Name extends keyof HostServices & string>(
    key: ScopeKey | null | undefined,
    service: Name,
  ): NonNullable<HostServices[Name]>;
  context(key?: ScopeKey | null): Context;
  address(key: ScopeKey): readonly ScopeKey[];
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessScopes: ScopePort;
  }
}
