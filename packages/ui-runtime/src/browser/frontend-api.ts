import type { Context } from 'cordis';
import type { PluginConfiguration } from '@mini-harness/kernel/configuration';
import type { BrowserContribution, BrowserRelease } from './contribution.js';

export interface FrontendApi {
  contribute<Args extends unknown[], Result>(point: BrowserContribution<Args, Result>, ...args: Args): Result;
  readonly configuration: PluginConfiguration;
  onDispose(cleanup: () => void | Promise<void>): BrowserRelease;
  readonly config: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
  /** Refresh a plugin-owned snapshot when this plugin invalidates its state. */
  watch(refresh: () => void | Promise<void>): BrowserRelease;
  watchScope(pluginId: string, target: { kind: 'workspace' | 'session'; id: string }, refresh: () => void | Promise<void>): BrowserRelease;
  scopeRequest<T>(pluginId: string, target: { kind: 'workspace' | 'session'; id: string }, operation: string,
    input?: unknown, signal?: AbortSignal): Promise<T>;
  readonly locale: {
    current(): string;
    subscribe(listener: (language: string) => void): BrowserRelease;
    text(messages: Record<string, string>, fallback: string): string;
  };
  request<T>(path: string, options?: RequestInit): Promise<T>;
}

export type FrontendSetup = (ctx: Context, api: FrontendApi) => void | BrowserRelease | Promise<void | BrowserRelease>;
