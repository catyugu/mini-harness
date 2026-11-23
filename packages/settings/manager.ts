import { HttpError } from '@mini-harness/contracts/routes';
import { isDeepStrictEqual } from 'node:util';
import { mergeSettings, parseSettings, readJson, writeJson } from '@mini-harness/platform/config';
import type { Paths, Settings } from '@mini-harness/contracts/config';
import type { PluginDescriptor } from '@mini-harness/contracts/plugins';
import type { SettingsPort, PluginConfigurationPort } from '@mini-harness/contracts/services';

export class SettingsManager implements SettingsPort {
  private stored: Settings;
  private pending = Promise.resolve();
  private migrated = false;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly paths: Paths, private readonly effective: (settings: Settings) => Settings,
    descriptors: readonly PluginDescriptor[]) {
    const input = readJson<unknown>(paths.settings, {});
    this.stored = parseSettings(input);
    for (const { id, migrateConfig } of descriptors) {
      if (!migrateConfig) continue;
      for (const [oldKey, key] of Object.entries(migrateConfig)) {
        if (!Object.hasOwn(input as object, oldKey)) continue;
        const values = this.stored.pluginConfig[id] ??= {};
        if (!Object.hasOwn(values, key)) values[key] = (input as Record<string, unknown>)[oldKey];
        this.migrated = true;
      }
    }
  }

  finishMigration() {
    if (this.migrated) this.save(this.stored);
  }

  get settings() { return this.effective(this.stored); }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private publish() {
    for (const listener of this.listeners) {
      try { listener(); } catch (error) { console.error('Settings listener failed', error); }
    }
  }

  private save(next: Settings) {
    writeJson(this.paths.settings, next);
    this.stored = next;
    this.migrated = false;
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

  update(patch: unknown, host: PluginConfigurationPort) {
    return this.transact(host, () => patch);
  }

  writePlugin(id: string, key: string | undefined, patch: unknown, host: PluginConfigurationPort, check: () => void) {
    return this.transact(host, () => {
      check();
      const values = configurationPatch(patch);
      if (!key) return { pluginConfig: { [id]: { ...this.stored.pluginConfig[id], ...values } } };
      const scope = this.stored.scopes[key];
      return { scopes: { ...this.stored.scopes, [key]: {
        ...scope, pluginConfig: { ...scope?.pluginConfig, [id]: { ...scope?.pluginConfig?.[id], ...values } }
      } } };
    }, true);
  }

  private transact(host: PluginConfigurationPort, patch: () => unknown, skipUnchanged = false) {
    const work = this.pending.then(async () => {
      const original = this.stored;
      const updated = mergeSettings(original, patch());
      if (skipUnchanged && isDeepStrictEqual(updated, original)) return this.settings;
      await host.configure(this.effective(updated), () => {
        // A conversation may have been deleted while the plugin graph was preparing.
        const removed = Object.keys(original.scopes).filter((key) => !Object.hasOwn(this.stored.scopes, key));
        const scopes = Object.fromEntries(Object.entries(updated.scopes).filter(([key]) => !removed.includes(key)));
        this.save({ ...updated, scopes });
      });
      this.publish();
      return this.settings;
    });
    this.pending = work.then(() => {}, () => {});
    return work;
  }
}

function configurationPatch(patch: unknown): Record<string, unknown> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch))
    throw new HttpError('invalid_input', 'Expected a plugin configuration object');
  try {
    return JSON.parse(JSON.stringify(patch, (_key, value: unknown) => {
      if (typeof value === 'number' && !Number.isFinite(value) ||
        ['undefined', 'function', 'symbol', 'bigint'].includes(typeof value)) throw new Error('Invalid JSON value');
      return value;
    }));
  } catch {
    throw new HttpError('invalid_input', 'Plugin settings must be JSON values');
  }
}
