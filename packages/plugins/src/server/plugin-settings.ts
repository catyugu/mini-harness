import { Service, type Context } from 'mini-harness/cordis';
import { pluginEntryFiber } from '@mini-harness/plugin-api/plugin-configuration';
import { entryAddress } from './entry-address.ts';
import { pluginConfiguration, type PluginConfiguration } from '@mini-harness/plugin-api/plugin-configuration';
import type { ScopeAddress } from '@mini-harness/plugin-api/configuration';

type ConfigWriter = (
  id: string,
  key: ScopeAddress | undefined,
  patch: unknown,
  check: () => void,
  signal: AbortSignal,
) => Promise<void>;

export function pluginSettings(
  writer: ConfigWriter,
  committed: (notify: () => void) => () => void,
): PluginConfiguration {
  const handles = new WeakMap<AbortSignal, PluginConfiguration>();
  function configuration(caller: Context) {
    const lifetime = caller.fiber.signal;
    let handle = handles.get(lifetime);
    if (handle) return handle;
    handle = pluginConfiguration(
      caller,
      (values, signal) => {
        const entry = pluginEntryFiber(caller).entry!;
        const { id, scope } = entryAddress(entry.options.id);
        return writer(id, scope, structuredClone(values), () => signal.throwIfAborted(), signal);
      },
      committed,
    );
    handles.set(lifetime, handle);
    return handle;
  }
  return Service.track({
    get<T>(key: string) {
      return configuration(Service.caller(this)).get<T>(key);
    },
    patch(values) {
      return configuration(Service.caller(this)).patch(values);
    },
    set(key, value) {
      return configuration(Service.caller(this)).set(key, value);
    },
    subscribe<T>(key: string, listener: (value: T) => void) {
      return configuration(Service.caller(this)).subscribe(key, listener);
    },
  });
}
