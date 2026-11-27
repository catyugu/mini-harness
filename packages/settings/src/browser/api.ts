import type { ProfileConfiguration } from '@mini-harness/plugin-api/configuration';
import type { RemoteStore } from '@mini-harness/ui-runtime/remote-store';
import type { PluginConfiguration } from '@mini-harness/plugin-api/plugin-configuration';
import type { PluginIcon } from '@mini-harness/plugin-api/descriptor';

export interface SettingsSection {
  id: string;
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
  sectionId: string;
  order?: number;
  render(context: SettingsContext): HTMLElement;
}

export interface PluginSettingsContribution {
  id: string;
  render(pluginId: string, signal: AbortSignal): HTMLElement | undefined;
}

declare module 'mini-harness/cordis' {
  interface Events {
    'settings/options'(
      schema: Record<string, any>,
      value: unknown,
    ): { label: string; value: unknown; disabled?: boolean }[] | undefined;
  }
  interface Context {
    miniSettings: {
      open(sectionId?: string): void;
      onClose(listener: () => void, signal: AbortSignal): void;
    };
    miniSettingsData: RemoteStore<ProfileConfiguration>;
    miniSettingsRegistry: {
      /** Define a section for this lifetime and return its metadata updater. */
      registerSection(
        section: SettingsSection,
        signal: AbortSignal,
      ): (metadata: Omit<SettingsSection, 'id'>) => void;
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
