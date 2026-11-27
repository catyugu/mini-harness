/** A symbolic icon name or an inline SVG path for plugin-defined artwork. */
export type PluginIcon = string | { path: string; viewBox?: string };

/** Optional presentation and resource declarations, independent of Cordis activation. */
export interface PluginInfo {
  title: string;
  description: string;
  /** Paths relative to the plugin's distribution root. */
  browser?: string;
  browserDirectory?: string;
  /** Explicit stylesheet order; otherwise styles in the public build directory are used. */
  browserStyles?: string[];
  icon?: PluginIcon;
  /** Optional static configuration schema for an entry that has not been imported. */
  configSchema?: Record<string, any>;
}

/** A physical module location, without presentation or runtime metadata. */
export interface PluginLocation {
  folder: string;
  entry?: string;
  exportName?: string;
  clientOnly?: boolean;
}
