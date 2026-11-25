import type { Plugin } from 'mini-harness/cordis';

/** A symbolic icon name or an inline SVG path for plugin-defined artwork. */
export type PluginIcon = string | { path: string; viewBox?: string };

/** Optional display and configuration information; not a Cordis plugin wrapper. */
export interface PluginInfo {
  title: string;
  description: string;
  web?: boolean;
  browser?: string;
  /** Styles shipped with a built-in browser entry. Local plugins may declare a browser build directory. */
  browserStyles?: string[];
  icon?: PluginIcon;
  configGroups?: { title: string; fields: string[] }[];
  configHint?: string;
}

/** Internal resolved entry, with the module and its display metadata kept distinct. */
export interface ResolvedPlugin extends PluginInfo {
  id: string;
  defaultEnabled?: boolean;
  location?: { url: string; exportName?: string };
  plugin?: Plugin;
  Config?: Plugin.Base['Config'];
  /** JSON form projection of the module's native Config, when available. */
  configSchema?: Record<string, any>;
  /** Explicit public projection for a module with both server and browser implementations. */
  browserConfig?: (config: Readonly<Record<string, unknown>>) => Record<string, unknown>;
}
