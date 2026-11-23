import type {} from 'cordis';

export type PluginScope = { kind: 'application' }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'session'; workspaceId: string; sessionId: string };

export interface ScopeSettings {
  disabledTools?: string[];
  /** A scoped selection replaces an inherited provider only in this subtree. */
  providers?: Record<string, string>;
  plugins?: Record<string, boolean>;
  pluginConfig?: Record<string, Record<string, unknown>>;
}

export interface ScopePort {
  prepare(sessionId: string, signal?: AbortSignal): Promise<void>;
  allowsTool(sessionId: string, tool: string): boolean;
  address(sessionId: string): readonly string[];
  release(sessionIds: string[], workspaceId?: string): Promise<void>;
}

declare module 'cordis' {
  interface Context {
    harnessScopes: ScopePort;
  }
}
