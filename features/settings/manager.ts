import { isDeepStrictEqual } from 'node:util';
import { mergeSettings, readSettings, writeJson, type Paths, type Settings, type SettingsPatch } from '../../src/config.js';
import type { ModelChoice } from '../../src/contracts/conversation.js';
import type { AgentPort, ConversationPort, SettingsPort } from '../../src/contracts/services.js';
import type { PluginHost } from '../../src/plugins/host.js';

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

  async update(patch: SettingsPatch, host: PluginHost, operations: ConversationPort, pi: AgentPort) {
    operations.assertAvailable();
    const next = mergeSettings(this.settings, patch);
    for (const validate of this.validators) validate(next);
    this.changing = true;
    try {
      await host.configure(next, () => {
        writeJson(this.paths.settings, next);
        this.settings = next;
        this.publish();
      }, () => {
        if (operations.hasActiveWork) throw new Error('Stop active conversations before reconfiguring plugins');
      });
      return next;
    } finally {
      this.changing = false;
      pi.reconcileResources();
    }
  }
}
