import { DomainError } from '@mini-harness/platform/errors';
import type { BrowserEntry } from './browser.js';
import type { Extension } from './contributions.js';
import type { Context } from 'cordis';
import type { PluginConfiguration, Settings } from './config.js';
import type { RouteHandler, UpgradeHandler } from './routes.js';
import type { PluginScope } from './capabilities.js';
import type { ServiceMap } from './plugin-sdk.js';

/** A symbolic icon name or an inline SVG path for plugin-defined artwork. */
export type PluginIcon = string | { path: string; viewBox?: string };

export interface PluginMetadata {
  id: string;
  scope?: PluginScope['kind'];
  title: string;
  description: string;
  trustedCode?: boolean;
  package?: { name: string; version: string };
  /** An installed but unusable plugin must never prevent the host from starting. */
  error?: string;
  state?: 'disabled' | 'inactive' | 'ready' | 'partial' | 'failed';
  provides?: string[];
  instances?: { scope: string; state: 'ready' | 'failed' | 'inactive' | 'disabled'; error?: string }[];
  defaultEnabled?: boolean;
  web?: boolean;
  browser?: string;
  icon?: PluginIcon;
  configGroups?: { title: string; fields: string[] }[];
  configHint?: string;
  requires?: string[];
  configSchema?: Record<string, any>;
}

export interface PluginDescriptor extends PluginMetadata {
  scope: PluginScope['kind'];
  required?: boolean;
  /** A mounted plugin may opt in to configuration updates without a restart. */
  configChanges?: 'live';
  validateConfig?(config: Readonly<Record<string, unknown>>, context: ConfigValidationContext): void;
  inject?: string[];
  optional?: string[];
  browserRequires?: string[];
  browserInject?: string[];
  browserProvides?: string[];
  setup?(ctx: Context, api: PluginApi): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}

export interface ConfigValidationContext {
  readonly operation: 'mount' | 'inspect' | 'write';
  service<Name extends keyof ServiceMap & string>(name: Name): NonNullable<ServiceMap[Name]>;
}

export interface PluginApi {
  /** The value comes from settings.pluginConfig[pluginId]. */
  readonly config: Readonly<Record<string, unknown>>;
  /** Committed values and writes in this instance's own namespace and scope. */
  readonly configuration: PluginConfiguration;
  /** A live plugin can update dependent resources before commit and on rollback. */
  onConfigChange(apply: (next: Readonly<Record<string, unknown>>) => void | Promise<void>): void;
  readonly scope: PluginScope;
  readonly signal: AbortSignal;
  provide<Name extends keyof ServiceMap & string>(name: Name, service: ServiceMap[Name]): void;
  service<Name extends keyof ServiceMap & string>(name: Name): NonNullable<ServiceMap[Name]>;
  optionalService<Name extends keyof ServiceMap & string>(name: Name): ServiceMap[Name] | undefined;
  contribute<Args extends unknown[], Result>(point: Extension<Args, Result>, ...args: Args): Result;
  /** Invalidate this plugin's application-wide state for its live browser clients. */
  invalidate(): void;
  /** Read and write an instance's private JSON data. */
  readonly storage: {
    read<T>(name: string, fallback: T): T;
    write(name: string, value: unknown): void;
    remove(name: string): void;
  };
  /** Use OS-backed private storage for values that must never enter browser configuration. */
  readonly secrets: {
    read(name: string): string | undefined;
    write(name: string, value: string): void;
    remove(name: string): void;
  };
  /** Mount an authenticated route under /api/extensions/<plugin-id>/. */
  registerRoute(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, handler: RouteHandler): () => Promise<void>;
  /** Mount a local authenticated WebSocket endpoint under /api/extensions/<plugin-id>/. */
  registerUpgrade(path: string, handler: UpgradeHandler): () => Promise<void>;
  onDispose(cleanup: () => void | Promise<void>): () => Promise<void>;
}

declare module 'cordis' {
  interface Context {
    harnessPluginCatalog: {
      metadata(): PluginMetadata[];
      reserved(id: string): boolean;
      diagnostics(): unknown;
      browser(): BrowserEntry[];
      writeBrowserConfig(id: string, patch: unknown, signal: AbortSignal): Promise<void>;
    };
  }
}

export interface PluginConfigurationPort {
  effective(settings: Settings): Settings;
  configure(settings: Settings, commit?: () => void): Promise<void>;
}

export const localPluginIdPattern = /^[a-z][a-z0-9-]{0,63}$/;
export const pluginIdPattern = /^(?:core:)?[a-z][a-z0-9-]{0,63}$/;
export const serviceNamePattern = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,95}$/;
export const scopeSettingsPattern = /^(?:workspace:[a-f0-9]{32}|session:[a-f0-9-]{36})$/;

export function validateProviderChoices(choices: Record<string, unknown>) {
  for (const [service, id] of Object.entries(choices)) {
    if (!serviceNamePattern.test(service) ||
        typeof id !== 'string' || !pluginIdPattern.test(id))
      throw new DomainError('invalid_input', 'Invalid provider selection');
  }
}

export function validatePluginSettings(plugins: Record<string, unknown>, configs: Record<string, unknown>) {
  for (const [key, value] of Object.entries(plugins)) {
    if (!localPluginIdPattern.test(key)) throw new DomainError('invalid_input', 'Invalid plugin name');
    if (typeof value !== 'boolean') throw new DomainError('invalid_input', 'Plugin switches must be boolean');
  }
  for (const [id, config] of Object.entries(configs)) {
    if (!pluginIdPattern.test(id) || (!config || typeof config !== 'object' || Array.isArray(config)))
      throw new DomainError('invalid_input', 'Invalid plugin configuration for ' + id);
  }
}
