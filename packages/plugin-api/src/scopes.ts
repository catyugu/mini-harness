import type { Context } from 'mini-harness/cordis';

export type PluginScope =
  | { kind: 'application' }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'session'; workspaceId: string; sessionId: string };

export interface ScopeSettings {
  plugins?: Record<string, boolean>;
  pluginConfig?: Record<string, Record<string, unknown>>;
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
