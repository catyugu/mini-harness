import { DomainError } from '@mini-harness/platform/errors';
import { isDeepStrictEqual } from 'node:util';
import { mergeSettings, readSettings } from './config.js';
import { writeJson } from '@mini-harness/platform/json';
import type { Paths } from '@mini-harness/platform/runtime-paths';
import type { SettingsPort } from './api.js';
import type { Settings } from '../shared/settings.js';

interface PluginConfigurationPort {
  effective(settings: Settings): Settings;
  configure(settings: Settings, commit?: () => void, released?: ReadonlySet<string>): Promise<void>;
}

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

  forgetPlugin<T>(id: string, uninstall: () => T) {
    return this.enqueue(() => {
      const plugins = { ...this.stored.plugins };
      const pluginConfig = { ...this.stored.pluginConfig };
      const readOnlyTools = { ...this.stored.readOnlyTools };
      delete plugins[id];
      delete pluginConfig[id];
      delete readOnlyTools[id];
      const scopes = Object.fromEntries(Object.entries(this.stored.scopes).map(([key, entry]) => {
        const scopedPlugins = { ...entry.plugins };
        const scopedConfig = { ...entry.pluginConfig };
        delete scopedPlugins[id];
        delete scopedConfig[id];
        return [key, { ...entry, plugins: scopedPlugins, pluginConfig: scopedConfig }];
      }));
      const result = uninstall();
      this.save({ ...this.stored, plugins, pluginConfig, scopes, readOnlyTools });
      this.publish();
      return result;
    });
  }

  forgetScopes(keys: string[]) {
    return this.enqueue(async () => {
      const released = new Set(keys);
      const scopes = Object.fromEntries(Object.entries(this.stored.scopes).filter(([key]) => !released.has(key)));
      const next = { ...this.stored, scopes };
      const changed = !isDeepStrictEqual(next, this.stored);
      const host = this.host();
      await host.configure(host.effective(next), () => { if (changed) this.save(next); }, released);
      if (changed) this.publish();
    });
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
    return this.enqueue(async () => {
      const next = mergeSettings(this.stored, patch());
      if (skipUnchanged && isDeepStrictEqual(next, this.stored)) return this.settings;
      const host = this.host();
      await host.configure(host.effective(next), () => this.save(next));
      this.publish();
      return this.settings;
    });
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new DomainError('unavailable', 'Settings are closing'));
    const work = this.pending.then(operation);
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
