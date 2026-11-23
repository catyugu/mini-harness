import { isDeepStrictEqual } from 'node:util';
import { mergeSettings, readSettings, writeJson } from '../platform/config.js';
import type { Paths, Settings, SettingsPatch } from '../contracts/config.js';
import type { ModelChoice } from '../contracts/conversation.js';
import type { SettingsPort, PluginConfigurationPort } from '../contracts/services.js';

export class SettingsManager implements SettingsPort {
  private stored: Settings;
  private updating = false;
  private readonly listeners = new Set<() => void>();
  private readonly validators = new Set<(settings: Settings) => void>();

  constructor(private readonly paths: Paths, private readonly effective: (settings: Settings) => Settings) {
    this.stored = readSettings(paths);
  }

  get settings() { return this.effective(this.stored); }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  validate(listener: (settings: Settings) => void) {
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
    this.save({ ...this.stored, plugins, pluginConfig });
    this.publish();
  }

  async update(patch: SettingsPatch, host: PluginConfigurationPort) {
    if (this.updating) throw new Error('Configuration is already changing');
    const updated = mergeSettings(this.stored, patch);
    const next = this.effective(updated);
    for (const validate of this.validators) validate(next);
    this.updating = true;
    try {
      await host.configure(next, () => {
        this.save(patch.model ? updated : { ...updated, model: this.stored.model });
      });
      this.publish();
      return this.settings;
    } finally { this.updating = false; }
  }
}
