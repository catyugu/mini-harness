import { HttpError } from '@mini-harness/contracts/routes';
import { isDeepStrictEqual } from 'node:util';
import { mergeSettings, readSettings, writeJson } from '@mini-harness/platform/config';
import type { Paths, Settings } from '@mini-harness/contracts/config';
import type { ModelChoice } from '@mini-harness/contracts/conversation';
import type { SettingsPort, PluginConfigurationPort } from '@mini-harness/contracts/services';

export class SettingsManager implements SettingsPort {
  private stored: Settings;
  private updating = false;
  private readonly listeners = new Set<() => void>();
  private readonly validators = new Set<(settings: Settings, previous: Settings) => void>();

  constructor(private readonly paths: Paths, private readonly effective: (settings: Settings) => Settings) {
    this.stored = readSettings(paths);
  }

  get settings() { return this.effective(this.stored); }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  validate(listener: (settings: Settings, previous: Settings) => void) {
    this.validators.add(listener);
    return () => { this.validators.delete(listener); };
  }

  private publish() {
    for (const listener of this.listeners) {
      try { listener(); } catch (error) { console.error('Settings listener failed', error); }
    }
  }

  private save(next: Settings) {
    writeJson(this.paths.settings, next);
    this.stored = next;
  }

  rememberModel(model: ModelChoice) {
    if (isDeepStrictEqual(this.stored.model, model)) return;
    this.save(mergeSettings(this.stored, { model }));
    this.publish();
  }

  forgetPlugin(id: string) {
    const plugins = { ...this.stored.plugins };
    const pluginConfig = { ...this.stored.pluginConfig };
    delete plugins[id];
    delete pluginConfig[id];
    const providers = Object.fromEntries(Object.entries(this.stored.providers).filter(([, provider]) => provider !== id));
    const scopes = Object.fromEntries(Object.entries(this.stored.scopes).map(([key, entry]) => {
      const scopedPlugins = { ...entry.plugins };
      const scopedConfig = { ...entry.pluginConfig };
      delete scopedPlugins[id];
      delete scopedConfig[id];
      const scopedProviders = Object.fromEntries(Object.entries(entry.providers ?? {}).filter(([, provider]) => provider !== id));
      return [key, { ...entry, plugins: scopedPlugins, pluginConfig: scopedConfig, providers: scopedProviders }];
    }));
    this.save({ ...this.stored, plugins, pluginConfig, providers, scopes });
    this.publish();
  }

  forgetScopes(keys: string[]) {
    const scopes = { ...this.stored.scopes };
    let changed = false;
    for (const key of keys) {
      if (!Object.hasOwn(scopes, key)) continue;
      delete scopes[key];
      changed = true;
    }
    if (changed) { this.save({ ...this.stored, scopes }); this.publish(); }
  }

  async update(patch: unknown, host: PluginConfigurationPort) {
    if (this.updating) throw new HttpError('conflict', 'Configuration is already changing');
    const originalScopes = this.stored.scopes;
    const updated = mergeSettings(this.stored, patch);
    const next = this.effective(updated);
    const modelChanged = Object.hasOwn(patch as object, 'model');
    for (const validate of this.validators) validate(next, this.settings);
    this.updating = true;
    try {
      await host.configure(next, () => {
        const removed = Object.keys(originalScopes).filter((key) => !Object.hasOwn(this.stored.scopes, key));
        const scopes = Object.fromEntries(Object.entries(updated.scopes).filter(([key]) => !removed.includes(key)));
        this.save({ ...updated, model: modelChanged ? updated.model : this.stored.model, scopes });
      });
      this.publish();
      return this.settings;
    } finally { this.updating = false; }
  }
}
