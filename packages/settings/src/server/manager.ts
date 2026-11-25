import { scopeKeys } from '@mini-harness/plugin-api/configuration';
import type { ScopeKey } from '@mini-harness/plugin-api/scopes';
import {
  assertOutsideMountTransaction,
  assertOutsidePluginRequest,
} from '@mini-harness/plugin-api/mutation-api';
import { DomainError } from '@mini-harness/platform/errors';
import { isDeepStrictEqual } from 'node:util';
import { mergeSettings } from './config.ts';
import type { ProfileRuntime } from '@mini-harness/plugin-api/profile';
import type { SettingsPort } from './api.ts';
import type { Settings } from '../shared/settings.ts';

export interface PluginConfigurationPort {
  effective(settings: Settings): Settings;
  configure(settings: Settings, commit?: () => void, released?: ReadonlySet<ScopeKey>): Promise<void>;
}

export class SettingsManager implements SettingsPort {
  private pending = Promise.resolve();
  private closing = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly profile: Pick<ProfileRuntime, 'read' | 'commit' | 'installed'>,
    private readonly host: () => PluginConfigurationPort,
  ) {}

  private get stored() {
    return this.profile.read();
  }

  get settings() {
    return this.host().effective(this.stored);
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error('Settings listener failed', error);
      }
    }
  }

  private save(next: Settings) {
    this.profile.commit(next);
  }

  forgetPlugin<T>(id: string, stage: (ids: readonly string[]) => { commit(): T; rollback(): void }) {
    assertOutsidePluginRequest();
    return this.enqueue(() => {
      const ids = [
        id,
        ...[...this.profile.installed].flatMap(([entry, module]) =>
          module === id && entry !== id ? [entry] : [],
        ),
      ];
      const plugins = { ...this.stored.plugins };
      const pluginConfig = { ...this.stored.pluginConfig };
      const readOnlyTools = { ...this.stored.readOnlyTools };
      const scopes = Object.fromEntries(
        Object.entries(this.stored.scopes).map(([key, entry]) => {
          const scopedPlugins = { ...entry?.plugins };
          const scopedConfig = { ...entry?.pluginConfig };
          for (const id of ids) {
            delete scopedPlugins[id];
            delete scopedConfig[id];
          }
          return [key, { ...entry, plugins: scopedPlugins, pluginConfig: scopedConfig }];
        }),
      );
      for (const id of ids) {
        delete plugins[id];
        delete pluginConfig[id];
        delete readOnlyTools[id];
      }
      const removal = stage(ids);
      try {
        this.save({ ...this.stored, plugins, pluginConfig, scopes, readOnlyTools });
      } catch (error) {
        removal.rollback();
        throw error;
      }
      const result = removal.commit();
      this.publish();
      return result;
    });
  }

  forgetScopes(keys: ScopeKey[]) {
    assertOutsidePluginRequest();
    return this.enqueue(async () => {
      const released = new Set(keys);
      const scopes = Object.fromEntries(
        scopeKeys(this.stored)
          .filter((key) => !released.has(key))
          .map((key) => [key, this.stored.scopes[key]]),
      );
      const next = { ...this.stored, scopes };
      const changed = !isDeepStrictEqual(next, this.stored);
      const host = this.host();
      await host.configure(
        host.effective(next),
        () => {
          if (changed) this.save(next);
        },
        released,
      );
      if (changed) this.publish();
    });
  }

  update(patch: unknown) {
    assertOutsidePluginRequest();
    return this.transact(() => patch);
  }

  writePlugin(id: string, key: ScopeKey | undefined, patch: unknown, check: () => void) {
    return this.transact(() => {
      check();
      const values = configurationPatch(patch);
      if (!key) return { pluginConfig: { [id]: { ...this.stored.pluginConfig[id], ...values } } };
      const scope = this.stored.scopes[key];
      return {
        scopes: {
          ...this.stored.scopes,
          [key]: {
            ...scope,
            pluginConfig: { ...scope?.pluginConfig, [id]: { ...scope?.pluginConfig?.[id], ...values } },
          },
        },
      };
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

  private async enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    assertOutsideMountTransaction();
    if (this.closing) return Promise.reject(new DomainError('unavailable', 'Settings are closing'));
    const work = this.pending.then(operation);
    this.pending = work.then(
      () => {},
      () => {},
    );
    return work;
  }
}

function configurationPatch(patch: unknown): Record<string, unknown> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch))
    throw new DomainError('invalid_input', 'Expected a plugin configuration object');
  try {
    return JSON.parse(
      JSON.stringify(patch, (_key, value: unknown) => {
        if (
          (typeof value === 'number' && !Number.isFinite(value)) ||
          ['undefined', 'function', 'symbol', 'bigint'].includes(typeof value)
        )
          throw new Error('Invalid JSON value');
        return value;
      }),
    );
  } catch {
    throw new DomainError('invalid_input', 'Plugin settings must be JSON values');
  }
}
