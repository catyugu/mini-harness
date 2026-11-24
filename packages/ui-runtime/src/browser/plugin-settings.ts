import { FiberState, type Context } from 'mini-harness/cordis';
import type { PluginConfiguration } from '@mini-harness/plugin-api/plugin-configuration';
import type {} from './graph-api.js';
import { browserRequest, payload } from './http.js';

export function browserPluginId(ctx: Context) {
  for (let fiber = ctx.fiber; fiber.runtime; fiber = fiber.parent.fiber) {
    if (fiber.entry) return fiber.entry.options.id;
  }
  throw new Error('Plugin configuration requires a browser entry');
}

export function browserPluginSettings(ctx: Context): PluginConfiguration {
  const id = browserPluginId(ctx);
  const signal = ctx.fiber.signal;
  const read = <T>(key: string, values = ctx.fiber.effectiveConfig as Record<string, unknown>): T => {
    signal.throwIfAborted();
    return structuredClone(Object.hasOwn(values, key) ? values[key] : undefined) as T;
  };
  const patch = async (values: Record<string, unknown>) => {
    signal.throwIfAborted();
    if (ctx.fiber.state !== FiberState.ACTIVE) throw new Error('Plugin settings cannot be written during setup');
    await browserRequest(ctx, '/settings/plugins/' + encodeURIComponent(id), payload('PATCH', values));
    await ctx.get('miniSwitch')?.();
  };
  return {
    get: read, patch,
    set: (key, value) => patch({ [key]: value }),
    subscribe<T>(key: string, listener: (value: T) => void) {
      let previous = JSON.stringify(read(key));
      return ctx.on('internal/update', (values, next) => {
        const value = read<T>(key, values);
        const serialized = JSON.stringify(value);
        if (serialized !== previous) {
          previous = serialized;
          listener(value);
        }
        return next();
      });
    }
  };
}
