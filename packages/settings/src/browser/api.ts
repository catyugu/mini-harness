import type { Settings } from '../shared/settings.js';
import type { RemoteStore } from '@mini-harness/ui-runtime/remote-store';
import type {} from 'cordis';
import type { BrowserContributionSource } from '@mini-harness/ui-runtime/contribution';
import type { PluginConfiguration } from '@mini-harness/kernel/configuration';
import type { PluginIcon } from '@mini-harness/plugin-api/descriptor';

export interface SettingsSection {
  title: string;
  icon?: PluginIcon;
  order?: number;
}

export interface SettingsContext {
  readonly signal: AbortSignal;
  readonly configuration: PluginConfiguration;
  /** Keep a control synchronized and return its inline error status. */
  bind<T>(control: HTMLInputElement | HTMLSelectElement, key: string, binding: {
    read(value: T): void;
    write(): T;
  }): HTMLElement;
}

export interface SettingsContribution {
  id: string;
  section: string | SettingsSection;
  order?: number;
  render(context: SettingsContext): HTMLElement;
}

export interface PluginSettingsContribution {
  id: string;
  render(pluginId: string, signal: AbortSignal): HTMLElement | undefined;
}

declare module 'cordis' {
  interface Context {
    miniSettings: {
      open(title?: string): void;
      onClose(listener: () => void, signal: AbortSignal): void;
    };
    miniSettingsData: RemoteStore<Settings>;
    miniSettingsRegistry: {
      register(owner: string, contribution: SettingsContribution, configuration: PluginConfiguration): () => void;
      registerPlugin(owner: string, contribution: PluginSettingsContribution): () => void;
      mountPlugin(pluginId: string, container: HTMLElement, signal: AbortSignal): void;
    };
  }
}

export const settingsExtensions = {
  plugin(source: BrowserContributionSource, contribution: PluginSettingsContribution) {
    return source.effect(() => source.service('miniSettingsRegistry').registerPlugin(source.id, contribution));
  },
  register(source: BrowserContributionSource, contribution: SettingsContribution) {
    return source.effect(() => source.service('miniSettingsRegistry').register(source.id, contribution, source.configuration));
  }
};
