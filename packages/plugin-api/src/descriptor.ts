import type { PluginConfiguration } from '@mini-harness/kernel/configuration';
import type { Extension } from '@mini-harness/kernel/contributions';
import type { Context } from 'cordis';
import type { RouteHandler, UpgradeHandler } from '@mini-harness/transport/routes';
import type { PluginScope } from '@mini-harness/kernel/scopes';
import type { ServiceMap } from '@mini-harness/kernel/services';

/** A symbolic icon name or an inline SVG path for plugin-defined artwork. */
export type PluginIcon = string | { path: string; viewBox?: string };

export interface PluginDescriptor {
  id: string;
  title: string;
  description: string;
  scope: PluginScope['kind'];
  defaultEnabled?: boolean;
  web?: boolean;
  browser?: string;
  /** Styles shipped with a built-in browser entry. Local plugins declare browserAssets in plugin.json. */
  browserStyles?: string[];
  icon?: PluginIcon;
  configGroups?: { title: string; fields: string[] }[];
  configHint?: string;
  requires?: string[];
  provides?: string[];
  configSchema?: Record<string, any>;
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
  /** Resolve the current declared provider for a prepared conversation. Do not retain it across configuration changes. */
  scopedService<Name extends keyof ServiceMap & string>(sessionId: string, name: Name): NonNullable<ServiceMap[Name]>;
  /** Prepare providers during normal operation. Not available from setup or configuration callbacks. */
  prepareSession(sessionId: string, signal?: AbortSignal): Promise<void>;
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
  /** Register a request handled only by this mounted workspace or session instance. */
  registerScopeRequest(name: string, handler: (input: unknown, signal: AbortSignal) => unknown | Promise<unknown>): () => Promise<void>;
  /** Mount a local authenticated WebSocket endpoint under /api/extensions/<plugin-id>/. */
  registerUpgrade(path: string, handler: UpgradeHandler): () => Promise<void>;
}
