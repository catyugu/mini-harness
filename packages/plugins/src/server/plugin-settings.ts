import { addAbortListener } from 'node:events';
import { isDeepStrictEqual } from 'node:util';
import { Service, type Context } from 'mini-harness/cordis';
import { pluginInstance } from '@mini-harness/plugin-api/instance';
import { pluginRequestSignal, assertOutsideMountTransaction } from '@mini-harness/plugin-api/mutation-api';
import type { PluginConfiguration } from '@mini-harness/plugin-api/plugin-configuration';
import type { ScopeKey } from '@mini-harness/plugin-api/scopes';
import type {} from '@mini-harness/settings/api';

type ConfigWriter = (id: string, key: ScopeKey | undefined, patch: unknown, check: () => void) => Promise<void>;

export function pluginSettings(root: Context, writer?: ConfigWriter): PluginConfiguration {
  const read = <T>(caller: Context, key: string): T => {
    caller.fiber.signal.throwIfAborted();
    const value = caller.fiber.effectiveConfig as Record<string, unknown>;
    return structuredClone(Object.hasOwn(value, key) ? value[key] : undefined) as T;
  };
  const write = async (caller: Context, values: Record<string, unknown>) => {
    assertOutsideMountTransaction();
    const request = pluginRequestSignal();
    const lifetime = caller.fiber.signal;
    const signal = request ? AbortSignal.any([lifetime, request]) : lifetime;
    const { pluginId, scopeKey, writableConfig } = pluginInstance(caller);
    const check = () => signal.throwIfAborted();
    check();
    if (!writer || !writableConfig) throw new Error('Plugin configuration writes require a live schema');
    let listener: ReturnType<typeof addAbortListener> | undefined;
    const aborted = new Promise<never>((_, reject) => {
      listener = addAbortListener(signal, () => reject(signal.reason));
    });
    try { await Promise.race([writer(pluginId, scopeKey, structuredClone(values), check), aborted]); }
    finally { listener?.[Symbol.dispose](); }
  };
  return Service.track({
    get<T>(key: string) { return read<T>(Service.caller(this), key); },
    patch(values) { return write(Service.caller(this), values); },
    set(key, value) { return write(Service.caller(this), { [key]: value }); },
    subscribe<T>(key: string, listener: (value: T) => void) {
      const caller = Service.caller(this);
      const signal = caller.fiber.signal;
      let previous = read<T>(caller, key);
      return caller.effect(() => root.harnessSettingsStore.subscribe(() => {
        if (signal.aborted) return;
        const next = read<T>(caller, key);
        if (isDeepStrictEqual(previous, next)) return;
        previous = structuredClone(next);
        listener(next);
      }));
    }
  });
}
