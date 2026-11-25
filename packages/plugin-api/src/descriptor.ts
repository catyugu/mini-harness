import type { Context, Plugin } from 'mini-harness/cordis';
import type { PluginScope } from './scopes.ts';

/** A symbolic icon name or an inline SVG path for plugin-defined artwork. */
export type PluginIcon = string | { path: string; viewBox?: string };

/** Optional display and configuration information; not a Cordis plugin wrapper. */
export interface PluginInfo {
  title: string;
  description: string;
  scope: PluginScope['kind'];
  /** Protected host and authorization service ownership. */
  protectServices?: readonly string[];
  trustedContributor?: boolean;
  web?: boolean;
  browser?: string;
  /** Styles shipped with a built-in browser entry. Local plugins declare browserAssets in plugin.json. */
  browserStyles?: string[];
  icon?: PluginIcon;
  configGroups?: { title: string; fields: string[] }[];
  configHint?: string;
  configSchema?: Record<string, any>;
  /** Top-level configuration fields explicitly shared with the browser entry. */
  browserConfig?: string[];
  /** A mounted plugin may opt in to configuration updates without a restart. */
  configChanges?: 'live';
  validateConfig?(config: Readonly<Record<string, unknown>>, context: ConfigValidationContext): void;
}

/** Internal resolved entry, with the module and its display metadata kept distinct. */
export interface ResolvedPlugin extends PluginInfo {
  id: string;
  defaultEnabled?: boolean;
  plugin?: Plugin;
}

export interface ConfigValidationContext {
  readonly operation: 'mount' | 'inspect' | 'write';
  service<Name extends keyof Context & string>(name: Name): NonNullable<Context[Name]>;
}
