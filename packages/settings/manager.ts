import { isDeepStrictEqual } from 'node:util';
import { mergeSettings, readSettings, writeJson, type Paths, type Settings, type SettingsPatch } from '../platform/config.js';
import type { ModelChoice } from '../contracts/conversation.js';
import type { AgentPort, ConversationPort, SettingsPort, PluginConfigurationPort } from '../contracts/services.js';

/** The settings capability owns persistence, validation hooks and the transaction boundary. */
export class SettingsManager implements SettingsPort {
  settings: Settings;
  changing = false;
  private readonly listeners = new Set<() => void>();
  private readonly validators = new Set<(settings: Settings) => void>();

  constructor(private readonly paths: Paths) { this.settings = readSettings(paths); }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  validate(listener: (settings: Settings) => void) {
    this.validators.add(listener);
    return () => { this.validators.delete(listener); };
  }

  private publish() {
    // Observer exceptions cannot roll back persisted settings or a successful Cordis mount.
    for (const listener of this.listeners) {
      try { listener(); } catch (error) { console.error('Settings listener failed', error); }
    }
  }

  rememberModel(model: ModelChoice) {
    if (isDeepStrictEqual(this.settings.model, model)) return;
    const next = mergeSettings(this.settings, { model });
    writeJson(this.paths.settings, next);
    this.settings = next;
    this.publish();
  }

  forgetPlugin(id: string) {
    const plugins = { ...this.settings.plugins };
    const pluginConfig = { ...this.settings.pluginConfig };
    delete plugins[id];
    delete pluginConfig[id];
    const next = { ...this.settings, plugins, pluginConfig };
    writeJson(this.paths.settings, next);
    this.settings = next;
    this.publish();
  }

  async update(patch: SettingsPatch, host: PluginConfigurationPort, operations: ConversationPort, pi: AgentPort) {
    operations.assertAvailable();
    const next = mergeSettings(this.settings, patch);
    for (const validate of this.validators) validate(next);
    let committed = false;
    try {
      await host.configure(next, () => {
        writeJson(this.paths.settings, next);
        this.settings = next;
        committed = true;
      }, () => {
        if (operations.hasActiveWork) throw new Error('Stop active conversations before reconfiguring plugins');
        // Live settings never block an in-progress run. Only actual plugin lifecycle
        // transitions reserve the agent service.
        this.changing = true;
      });
      return next;
    } finally {
      this.changing = false;
      try { pi.reconcileResources(); }
      finally { if (committed) this.publish(); }
    }
  }
}
