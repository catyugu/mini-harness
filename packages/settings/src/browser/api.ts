import type { Settings } from '../shared/settings.ts';
import type { RemoteStore } from '@mini-harness/ui-runtime/remote-store';
import type { PluginConfiguration } from '@mini-harness/plugin-api/plugin-configuration';
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
  bind<T>(
    control: HTMLInputElement | HTMLSelectElement,
    key: string,
    binding: {
      read(value: T): void;
      write(): T;
    },
  ): HTMLElement;
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

declare module 'mini-harness/cordis' {
  interface Context {
    miniSettings: {
      open(title?: string): void;
      onClose(listener: () => void, signal: AbortSignal): void;
    };
    miniSettingsData: RemoteStore<Settings>;
    miniSettingsRegistry: {
      register(
        owner: string,
        contribution: SettingsContribution,
        configuration: PluginConfiguration,
      ): () => void;
      registerPlugin(owner: string, contribution: PluginSettingsContribution): () => void;
      mountPlugin(pluginId: string, container: HTMLElement, signal: AbortSignal): void;
    };
  }
}
