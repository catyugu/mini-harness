import type { Context, Plugin } from 'mini-harness/cordis';
import type { PluginScope } from './scopes.ts';

/** A symbolic icon name or an inline SVG path for plugin-defined artwork. */
export type PluginIcon = string | { path: string; viewBox?: string };

export interface PluginDescriptor {
  id: string;
  title: string;
  description: string;
  scope: PluginScope['kind'];
  defaultEnabled?: boolean;
  /** Runtime constraints declared by the active Profile and trusted built-in modules. */
  required?: boolean;
  protectServices?: readonly string[];
  trustedContributor?: boolean;
  web?: boolean;
  browser?: string;
  /** Styles shipped with a built-in browser entry. Local plugins declare browserAssets in plugin.json. */
  browserStyles?: string[];
  icon?: PluginIcon;
  configGroups?: { title: string; fields: string[] }[];
  configHint?: string;
  provides?: string[];
  configSchema?: Record<string, any>;
  /** A mounted plugin may opt in to configuration updates without a restart. */
  configChanges?: 'live';
  validateConfig?(config: Readonly<Record<string, unknown>>, context: ConfigValidationContext): void;
  inject?: string[];
  optional?: string[];
  plugin?: Plugin;
}

export interface ConfigValidationContext {
  readonly operation: 'mount' | 'inspect' | 'write';
  service<Name extends keyof Context & string>(name: Name): NonNullable<Context[Name]>;
}
