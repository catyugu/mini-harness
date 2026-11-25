import type { Plugin } from 'mini-harness/cordis';
import type { PluginScope } from './scopes.ts';

/** A symbolic icon name or an inline SVG path for plugin-defined artwork. */
export type PluginIcon = string | { path: string; viewBox?: string };

/** Optional display and configuration information; not a Cordis plugin wrapper. */
export interface PluginInfo {
  title: string;
  description: string;
  scope: PluginScope['kind'];
  trustedContributor?: boolean;
  web?: boolean;
  /** Built-in modules declare a relative TypeScript source; installed packages declare a built entry. */
  browser?: string;
  /** Styles relative to the declaring built-in module. Local plugins may declare a browser build directory. */
  browserStyles?: string[];
  icon?: PluginIcon;
  configGroups?: { title: string; fields: string[] }[];
  configHint?: string;
  /** Optional JSON form description for unloaded entries; runtime validation belongs to Config. */
  configSchema?: Record<string, any>;
}

/** Internal resolved entry, with the module and its display metadata kept distinct. */
export interface ResolvedPlugin extends PluginInfo {
  id: string;
  defaultEnabled?: boolean;
  plugin?: Plugin;
  Config?: Plugin.Base['Config'];
}
