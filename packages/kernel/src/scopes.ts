import type { Context } from 'cordis';
import type { ServiceMap } from './services.js';

export type PluginScope = { kind: 'application' }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'session'; workspaceId: string; sessionId: string };

export interface ScopeSettings {
  /** A scoped selection replaces an inherited provider only in this subtree. */
  providers?: Record<string, string>;
  plugins?: Record<string, boolean>;
  pluginConfig?: Record<string, Record<string, unknown>>;
}

export type HostServices = ServiceMap & Pick<Context, Extract<keyof Context, `harness${string}`>>;

export type ScopeKey = `${Exclude<PluginScope['kind'], 'application'>}:${string}`;

export type ScopeAddress = { scope: Exclude<PluginScope, { kind: 'application' }>; parent?: ScopeKey };

export interface ScopePort {
  register(kind: ScopeAddress['scope']['kind'], resolve: (id: string) => ScopeAddress | undefined, eager?: boolean): () => void;
  prepare(key: ScopeKey, signal?: AbortSignal): Promise<void>;
  /** Read the nearest prepared Cordis service without changing a parent or sibling scope. */
  require<Name extends keyof HostServices & string>(key: ScopeKey | null | undefined, service: Name): NonNullable<HostServices[Name]>;
  optional<Name extends keyof HostServices & string>(key: ScopeKey | null | undefined, service: Name): HostServices[Name] | undefined;
  address(key: ScopeKey): readonly string[];
}

declare module 'cordis' {
  interface Context {
    harnessScopes: ScopePort;
  }
}
