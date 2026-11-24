import type { PluginSettings } from '@mini-harness/plugin-api/configuration';

export interface Settings extends PluginSettings { port: number }

export type SettingsPatch = { [K in keyof Settings]?: Settings[K] extends object ? Partial<Settings[K]> : Settings[K] };
