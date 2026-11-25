import { addAbortListener } from 'node:events';
import { Service, type Context } from 'mini-harness/cordis';
import { pluginInstance } from '@mini-harness/plugin-api/instance';
import { pluginRequestSignal, assertOutsideMountTransaction } from '@mini-harness/plugin-api/mutation-api';
import { pluginConfiguration, type PluginConfiguration } from '@mini-harness/plugin-api/plugin-configuration';
import type { ScopeAddress } from '@mini-harness/plugin-api/configuration';

type ConfigWriter = (
  id: string,
  key: ScopeAddress | undefined,
  patch: unknown,
  check: () => void,
) => Promise<void>;

export function pluginSettings(root: Context, writer?: ConfigWriter): PluginConfiguration {
  const handles = new WeakMap<AbortSignal, PluginConfiguration>();
  function configuration(caller: Context) {
    const lifetime = caller.fiber.signal;
    let handle = handles.get(lifetime);
    if (handle) return handle;
    handle = pluginConfiguration(
      caller,
      async (values, signal) => {
        assertOutsideMountTransaction();
        const request = pluginRequestSignal();
        const active = request ? AbortSignal.any([signal, request]) : signal;
        const { pluginId, scopeAddress, writableConfig } = pluginInstance(caller);
        const check = () => active.throwIfAborted();
        check();
        if (!writer || !writableConfig) throw new Error('Plugin configuration writes require a live Entry');
        let listener: ReturnType<typeof addAbortListener> | undefined;
        const aborted = new Promise<never>((_, reject) => {
          listener = addAbortListener(active, () => reject(active.reason));
        });
        try {
          await Promise.race([writer(pluginId, scopeAddress, structuredClone(values), check), aborted]);
        } finally {
          listener?.[Symbol.dispose]();
        }
      },
      (notify) => root.harnessSettingsStore.subscribe(notify),
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
