import { DomainError } from '@mini-harness/platform/errors';
import { isDeepStrictEqual } from 'node:util';
import { mergeSettings, readSettings } from './config.js';
import { writeJson } from '@mini-harness/platform/json';
import type { Paths } from '@mini-harness/platform/runtime-paths';
import type { Settings, SettingsPort } from './api.js';
import type { PluginConfigurationPort } from '@mini-harness/plugin-api/configuration';

export class SettingsManager implements SettingsPort {
  private stored: Settings;
  private pending = Promise.resolve();
  private closing = false;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly paths: Paths, private readonly host: () => PluginConfigurationPort) {
    this.stored = readSettings(paths);
  }

  get settings() { return this.host().effective(this.stored); }

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

  update(patch: unknown) {
    return this.transact(() => patch);
  }

  writePlugin(id: string, key: string | undefined, patch: unknown, check: () => void) {
    return this.transact(() => {
      check();
      const values = configurationPatch(patch);
      if (!key) return { pluginConfig: { [id]: { ...this.stored.pluginConfig[id], ...values } } };
      const scope = this.stored.scopes[key];
      return { scopes: { ...this.stored.scopes, [key]: {
        ...scope, pluginConfig: { ...scope?.pluginConfig, [id]: { ...scope?.pluginConfig?.[id], ...values } }
      } } };
    }, true);
  }

  close() {
    this.closing = true;
    return this.pending;
  }

  private transact(patch: () => unknown, skipUnchanged = false) {
    if (this.closing) return Promise.reject(new DomainError('unavailable', 'Settings are closing'));
    const work = this.pending.then(async () => {
      const original = this.stored;
      const updated = mergeSettings(original, patch());
      if (skipUnchanged && isDeepStrictEqual(updated, original)) return this.settings;
      const host = this.host();
      await host.configure(host.effective(updated), () => {
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
    throw new DomainError('invalid_input', 'Expected a plugin configuration object');
  try {
    return JSON.parse(JSON.stringify(patch, (_key, value: unknown) => {
      if (typeof value === 'number' && !Number.isFinite(value) ||
        ['undefined', 'function', 'symbol', 'bigint'].includes(typeof value)) throw new Error('Invalid JSON value');
      return value;
    }));
  } catch {
    throw new DomainError('invalid_input', 'Plugin settings must be JSON values');
  }
}
