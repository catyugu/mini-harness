import type { PluginSettings } from '@mini-harness/plugin-api/configuration';

export interface Settings extends PluginSettings {
  port: number;
  readOnlyTools: Record<string, string[]>;
}

export type SettingsPatch = {
  [K in keyof Settings]?: Settings[K] extends object ? Partial<Settings[K]> : Settings[K];
};

declare module '@mini-harness/plugin-api/scopes' {
  interface ScopeSettings {
    disabledTools?: string[];
  }
}
