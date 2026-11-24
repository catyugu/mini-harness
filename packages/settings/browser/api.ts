import type { Settings } from '../api.js';
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

declare module 'cordis' {
  interface Context {
    miniSettings: {
      open(title?: string): void;
      onClose(listener: () => void, signal: AbortSignal): void;
    };
    miniSettingsData: RemoteStore<Settings>;
    miniSettingsRegistry: {
      register(owner: string, contribution: SettingsContribution, configuration: PluginConfiguration): () => void;
    };
  }
}

export const settingsExtensions = {
  register(source: BrowserContributionSource, contribution: SettingsContribution) {
    return source.effect(() => source.service('miniSettingsRegistry').register(source.id, contribution, source.configuration));
  }
};
