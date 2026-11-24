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

export interface ScopePort {
  prepare(sessionId: string, signal?: AbortSignal): Promise<void>;
  /** Read the nearest prepared Cordis service without changing a parent or sibling scope. */
  require<Name extends keyof HostServices & string>(sessionId: string | null | undefined, service: Name): NonNullable<HostServices[Name]>;
  optional<Name extends keyof HostServices & string>(sessionId: string | null | undefined, service: Name): HostServices[Name] | undefined;
  address(sessionId: string): readonly string[];
  release(sessionIds: string[], workspaceId?: string): Promise<void>;
}

declare module 'cordis' {
  interface Context {
    harnessScopes: ScopePort;
  }
}
